import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { createWriteStream, type WriteStream } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  ConfigError,
  createId,
  ExitCode,
  exitCodeForJob,
  fingerprintFromDirectory,
  formatJobSource,
  JOB_SOURCE_MAX_LINKS,
  loadRepoConfig,
  needsDependencyRefresh,
  sessionName,
  type DependencyFingerprint,
  type JobSource,
  type JobState,
  type MutagenSessionInfo,
  type ProfileConfig,
  type TestboxConfig,
} from '@testbox/shared';
import { CliApiError, exitCodeForCliError, HttpApi } from './api-client';
import {
  readUserConfig,
  readWorkspaceState,
  removeWorkspaceState,
  workspaceSessionNames,
  writeUserConfig,
  writeWorkspaceState,
  type UserConfig,
  type WorkerSession,
  type WorkspaceState,
} from './config-store';
import { attachInterrupt, watchDetach } from './interrupt';
import { withSnapshotLocks } from './lock';
import { Output, type Summary, type TextSink } from './output';
import { mutagenDestination, MutagenSsh, RemoteUnavailable, SyncError, type RemoteRunner } from './remote';
import { LinkError, parseLinkFlags, resolveLinks, type LinkedCheckout } from './links';
import { collectSource } from './source';

export interface CliIO {
  stdout: TextSink;
  stderr: TextSink;
  cwd: string;
  homeDir: string;
  isTTY: boolean;
  prompt: (question: string) => Promise<string>;
  signals: EventEmitter;
  remote: RemoteRunner;
  fetchImpl?: typeof fetch;
}

interface CommonFlags {
  json?: boolean;
  workspace?: string;
  timeout?: string;
  priority?: string;
  direct?: boolean;
  detach?: boolean;
  sshHost?: string;
  profile?: string;
  quiet?: boolean;
  /** `--link <name>=<path>`, repeatable. */
  link?: string[];
}

/** One checkout that is synced to the worker for a job: the main checkout or a link. */
interface SyncedTree {
  /** The folder name in the snapshot: the project for the main tree, the link name for a link. */
  name: string;
  dir: string;
  ignore: string[];
  state: WorkspaceState;
}

/** Wrong arguments: the CLI exits 2, so a caller does not read it as a failed job. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

type LoadedConfig = { file: string; config: TestboxConfig };

/**
 * The job log on disk, so a caller can read it again after the stream ended (or with --quiet).
 * A file that cannot be written never fails the job: `error` says why, and the lines are dropped.
 */
class LogFile {
  private stream: WriteStream | null = null;
  error: string | null = null;

  constructor(readonly file: string) {}

  /** The file, for the summary; none when it could not be written. */
  get path(): string | undefined {
    return this.error ? undefined : this.file;
  }

  async open(): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const stream = createWriteStream(this.file, { flags: 'w' });
      await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', reject);
      });
      stream.on('error', (err) => this.drop(err));
      this.stream = stream;
    } catch (err) {
      this.drop(err);
    }
  }

  write(text: string): void {
    this.stream?.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    await new Promise<void>((resolve) => stream.end(resolve));
  }

  private drop(err: unknown): void {
    this.error ??= `cannot write ${this.file}: ${err instanceof Error ? err.message : String(err)}`;
    this.stream?.destroy();
    this.stream = null;
  }
}

export class TestboxApp {
  constructor(
    private readonly io: CliIO,
    private readonly json: boolean,
  ) {}

  private out(flags?: CommonFlags): Output {
    return new Output(this.json, this.io.stdout, this.io.stderr, Boolean(flags?.quiet));
  }

  async login(token: string, apiUrl: string, sshHost?: string): Promise<number> {
    const output = this.out();
    const previous = await readUserConfig(this.io.homeDir);
    const config: UserConfig = {
      apiUrl: apiUrl.replace(/\/$/, ''),
      token,
      sshHost: sshHost ?? previous?.sshHost,
      remoteRoot: previous?.remoteRoot ?? '~/testbox',
      identityFile: previous?.identityFile,
      snapshotBin: previous?.snapshotBin ?? 'testbox/app/packages/worker/dist/snapshot-cli.js',
    };
    try {
      const api = this.api(config);
      await api.me();
    } catch (err) {
      const code = exitCodeForCliError(err) ?? ExitCode.Auth;
      output.failure(err instanceof Error ? err.message : 'login failed', code);
      return code;
    }
    await writeUserConfig(this.io.homeDir, config);
    output.summary({ ok: true, exitCode: 0, exit: 0 });
    return ExitCode.Pass;
  }

  /** List the profiles of testbox.yml, so a caller does not parse the YAML itself. */
  async profiles(): Promise<number> {
    const output = this.out();
    try {
      const loaded = await loadRepoConfig(this.io.cwd);
      const profiles = Object.entries(loaded.config.profiles).map(([name, profile]) => ({
        name,
        command: profile.cmd,
        requires: profile.requires,
        artifacts: profile.artifacts,
        links: profile.links,
      }));
      if (this.json) {
        output.event({ type: 'profiles', file: loaded.file, project: loaded.config.project, profiles });
        output.summary({ ok: true, exitCode: 0, exit: 0 });
        return ExitCode.Pass;
      }
      this.io.stderr.write(`${loaded.file}\n`);
      if (profiles.length === 0) this.io.stdout.write('no profiles\n');
      for (const profile of profiles) {
        const requires = profile.requires.length ? ` [${profile.requires.join(', ')}]` : '';
        const links = profile.links.map((link) => ` +${link}`).join('');
        this.io.stdout.write(`${profile.name}${requires}${links}: ${profile.command}\n`);
      }
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  async start(flags: CommonFlags): Promise<number> {
    const output = this.out(flags);
    try {
      const loaded = await loadRepoConfig(this.io.cwd);
      const user = await this.requireUser(flags.direct === true);
      const { state, reused } = await this.createWorkspace(loaded, user, flags, output, []);
      output.summary({ jobId: state.id, state: 'started', exitCode: 0, exit: 0 });
      if (!this.json) {
        if (reused) output.info(`reused workspace ${state.id}`);
        output.info(`session ${state.sessionName}`);
      }
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  /**
   * Make or reuse the workspace of this checkout and its Mutagen session, and write
   * .testbox/workspace.json. `start` calls it, and so does `verify` when there is no workspace yet.
   */
  private async createWorkspace(
    loaded: LoadedConfig,
    user: UserConfig | null,
    flags: CommonFlags,
    output: Output,
    requires: string[],
    worker?: { id: string; sshHost: string } | null,
  ): Promise<{ state: WorkspaceState; reused: boolean }> {
    const direct = flags.direct === true;
    const configDir = path.dirname(loaded.file);
    const project = loaded.config.project;
    // A state file copied from another checkout is not ours: its sessions sync that other checkout.
    const stored = await readWorkspaceState(configDir);
    const previous = stored && stored.configDir === configDir ? stored : null;
    let sshHost = flags.sshHost || user?.sshHost || loaded.config.sshHost;
    const remoteRoot = user?.remoteRoot ?? '~/testbox';
    // Mutagen runs on this machine; the ssh host does not matter for list and terminate.
    const mutagen = this.ssh(sshHost ?? '', user?.identityFile);
    const previousNames = previous ? workspaceSessionNames(previous) : [];
    const allSessions = await mutagen.list();
    // A session of ours is alive only when it still syncs this checkout.
    const live = new Set(allSessions.filter((session) => session.alphaPath === configDir).map((session) => session.name));
    let id = checkoutId(configDir);
    let stagingRel = `workspaces/local/${project}/${id}`;
    let workerId: string | undefined;
    let reused: WorkspaceState | null = null;
    if (direct) {
      if (previous?.direct && previous.id === id) reused = previous;
    } else {
      if (!user) throw new CliApiError('not logged in', 'AUTH', 401);
      const api = this.api(user);
      const existing = previous && !previous.direct ? await findWorkspace(api, previous.id) : null;
      if (existing && existing.stagingRel.endsWith(`/${existing.id}`)) {
        id = existing.id;
        stagingRel = existing.stagingRel;
        reused = previous;
      } else {
        // The workspace is gone on the API, or it still has the old shared folder: its sessions are stale.
        await terminateAll(mutagen, previousNames.filter((old) => live.has(old)));
        live.clear();
        if (existing) {
          await api.deleteWorkspace(existing.id);
          if (!this.json) output.info(`workspace ${existing.id} used the old shared folder; making a new one`);
        }
        const created = await api.createWorkspace(project);
        id = created.id;
        stagingRel = created.stagingRel;
      }
      // The first session goes to the worker that will run the job, so one SSH host is probed, not two.
      // A link takes the worker of the main checkout; its own selection could name another one.
      const selected = worker ?? (await api.selectWorker({ requires, workspaceId: id }));
      if (selected?.sshHost) {
        sshHost = selected.sshHost;
        workerId = selected.id;
      }
    }
    if (!sshHost) throw new UsageError('ssh host is required (testbox.yml sshHost, login, or --ssh-host)');
    // Keep the live sessions of a reused workspace. Keep the session for this host if it is alive.
    const sessions: Record<string, WorkerSession> = {};
    for (const [key, session] of Object.entries(reused?.sessions ?? {})) {
      if (live.has(session.sessionName)) sessions[key] = session;
    }
    const current = workerId
      ? sessions[workerId]
      : reused && { sessionName: reused.sessionName, sshHost: reused.sshHost };
    let name = sessionName(project, id, workerId);
    const keep = Boolean(current && current.sshHost === sshHost && live.has(current.sessionName));
    if (current && keep) {
      name = current.sessionName;
    } else if (workerId) {
      // The session for this worker is gone, or it points at another host: replace it.
      delete sessions[workerId];
    }
    if (workerId) sessions[workerId] = { sessionName: name, sshHost };
    for (const root of otherRootsSyncingTo(allSessions, stagingRel, configDir)) {
      output.error(`warning: ${root} also syncs to this worker folder; run testbox stop there, then testbox start here`);
    }
    const state: WorkspaceState = {
      id,
      project,
      sessionName: name,
      stagingRel,
      sshHost,
      remoteRoot,
      direct,
      configDir,
      workerId,
      sessions: Object.keys(sessions).length > 0 ? sessions : undefined,
    };
    // The state names the session before the session exists, so a concurrent prune keeps it.
    await writeWorkspaceState(configDir, state);
    if (!keep) {
      const kept = new Set(Object.values(sessions).map((session) => session.sessionName));
      kept.delete(name);
      await terminateAll(mutagen, previousNames.filter((old) => live.has(old) && !kept.has(old)));
      const ssh = this.ssh(sshHost, user?.identityFile);
      await ssh.ensureStaging(remoteRoot, stagingRel);
      await ssh.create({
        name,
        source: configDir,
        destination: mutagenDestination(sshHost, remoteRoot, stagingRel),
        ignore: loaded.config.ignore,
      });
    }
    return { state, reused: reused !== null };
  }

  async stop(): Promise<number> {
    const output = this.out();
    try {
      const loaded = await loadRepoConfig(this.io.cwd);
      const state = await readWorkspaceState(path.dirname(loaded.file));
      if (!state) {
        output.failure('no workspace to stop', ExitCode.JobFailed);
        return ExitCode.JobFailed;
      }
      const user = await readUserConfig(this.io.homeDir);
      await terminateAll(this.ssh(state.sshHost, user?.identityFile), workspaceSessionNames(state));
      if (!state.direct && user) {
        try {
          await this.api(user).deleteWorkspace(state.id);
        } catch (err) {
          if (!(err instanceof CliApiError) || err.status !== 404) throw err;
        }
      }
      await removeWorkspaceState(path.dirname(loaded.file));
      output.summary({ jobId: state.id, state: 'stopped', exitCode: 0, exit: 0 });
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  /** A custom command. With `--profile`, the job also gets that profile's `requires` and `artifacts`. */
  async run(command: string, flags: CommonFlags): Promise<number> {
    if (!flags.profile) return this.execute(command, null, null, flags);
    const profile = await this.findProfile(flags.profile, flags);
    if (typeof profile === 'number') return profile;
    return this.execute(command, flags.profile, profile, flags);
  }

  async verify(profileName: string, flags: CommonFlags): Promise<number> {
    const profile = await this.findProfile(profileName, flags);
    if (typeof profile === 'number') return profile;
    return this.execute(profile.cmd, profileName, profile, flags);
  }

  /** The profile from testbox.yml, or the exit code after the failure is printed. */
  private async findProfile(profileName: string, flags: CommonFlags): Promise<ProfileConfig | number> {
    const output = this.out(flags);
    let loaded;
    try {
      loaded = await loadRepoConfig(this.io.cwd);
    } catch (err) {
      return this.fail(output, err);
    }
    const profile = loaded.config.profiles[profileName];
    if (!profile) {
      const names = Object.keys(loaded.config.profiles);
      const known = names.length ? `the profiles in ${loaded.file} are: ${names.join(', ')}` : `${loaded.file} has no profiles`;
      return this.fail(output, new UsageError(`unknown profile ${profileName}; ${known}`));
    }
    return profile;
  }

  async status(jobId: string): Promise<number> {
    const output = this.out();
    try {
      const user = await this.requireUser(false);
      if (!user) return ExitCode.Auth;
      const { job } = await this.api(user).getJob(jobId);
      const exit = exitCodeForJob(job.state);
      output.summary({ jobId: job.id, state: job.state, exitCode: job.exitCode, error: job.error, source: job.source ?? undefined, exit });
      if (!this.json && job.source) output.info(formatJobSource(job.source));
      return exit;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  async logs(jobId: string, follow: boolean): Promise<number> {
    const output = this.out();
    try {
      const user = await this.requireUser(false);
      if (!user) return ExitCode.Auth;
      const api = this.api(user);
      if (!follow) {
        const body = await api.logs(jobId);
        for (const line of body.lines) output.line(line.stream, line.line);
        const job = await api.getJob(jobId);
        const exit = exitCodeForJob(job.job.state);
        output.summary({ jobId, state: job.job.state, exitCode: job.job.exitCode, error: job.job.error, exit });
        return exit;
      }
      return await this.follow(api, jobId, output, await this.logFileNearConfig(jobId));
    } catch (err) {
      return this.fail(output, err);
    }
  }

  async cancel(jobId: string): Promise<number> {
    const output = this.out();
    try {
      const user = await this.requireUser(false);
      if (!user) return ExitCode.Auth;
      const { job } = await this.api(user).cancel(jobId);
      const exit = job.state === 'cancelled' ? ExitCode.Cancelled : exitCodeForJob(job.state);
      output.summary({ jobId: job.id, state: job.state, exitCode: job.exitCode, error: job.error, exit });
      return exit;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  async artifacts(jobId: string): Promise<number> {
    const output = this.out();
    try {
      const user = await this.requireUser(false);
      if (!user) return ExitCode.Auth;
      const api = this.api(user);
      const files = await api.listArtifacts(jobId);
      const dest = path.join(this.io.cwd, '.testbox', jobId);
      await mkdir(dest, { recursive: true });
      for (const file of files) {
        const bytes = await api.downloadArtifact(jobId, file.path);
        const target = path.join(dest, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      output.summary({ jobId, state: 'artifacts', exitCode: 0, exit: 0 });
      if (!this.json) output.info(dest);
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  private async execute(
    command: string,
    profileName: string | null,
    profile: ProfileConfig | null,
    flags: CommonFlags,
  ): Promise<number> {
    const output = this.out(flags);
    try {
      const timeoutMs = this.timeoutMs(flags);
      const loaded = await loadRepoConfig(this.io.cwd);
      const configDir = path.dirname(loaded.file);
      const overrides = parseLinkFlags(flags.link, this.io.cwd);
      const linkNames = jobLinkNames(loaded.config.project, profileName, profile, overrides);
      if (flags.direct && linkNames.length > 0) throw new UsageError('links need the control plane; run without --direct');
      // Find every linked checkout before any network call: a missing one is a mistake in the call.
      const links = await resolveLinks(configDir, loaded.config.project, linkNames, overrides);
      const user = await this.requireUser(flags.direct === true);
      const requires = profile?.requires ?? [];
      if (flags.direct) {
        const state = await this.resolveState(loaded, flags, user, output, requires);
        const ssh = this.ssh(state.sshHost, user?.identityFile);
        await ssh.flush(state.sessionName);
        await this.printSource(output, configDir, []);
        return await this.direct(ssh, state, command, output, timeoutMs);
      }
      if (!user) return ExitCode.Auth;
      const api = this.api(user);
      // A SIGTERM during the submit (a tool's time limit) must still end in a summary: the submit
      // finishes, and the CLI then detaches instead of following.
      const stop = watchDetach(this.io.signals);
      let submitted: { job: { id: string; state: string } };
      try {
        // Another run on this machine may share a checkout (a link of both): hold every checkout from the
        // first read of its workspace state to the resume of its sync, so the two runs take turns.
        submitted = await withSnapshotLocks([configDir, ...links.map((link) => link.dir)], () =>
          this.submit(loaded, links, user, api, command, profileName, profile, flags, output, timeoutMs),
        );
      } finally {
        stop.dispose();
      }
      output.event({ type: 'status', state: submitted.job.state, jobId: submitted.job.id });
      if (flags.detach || stop.requested()) {
        output.summary(detachedSummary(submitted.job.id));
        return ExitCode.Pass;
      }
      return await this.follow(api, submitted.job.id, output, this.logFile(configDir, submitted.job.id));
    } catch (err) {
      return this.fail(output, err);
    }
  }

  /** The `source` event (or line): the main checkout and its links. */
  private async printSource(output: Output, configDir: string, links: LinkedCheckout[]): Promise<JobSource> {
    const source = await collectSource(this.io.remote, configDir);
    if (links.length > 0) {
      source.links = [];
      for (const link of links) source.links.push({ name: link.name, ...(await collectSource(this.io.remote, link.dir)) });
    }
    if (this.json) output.event({ type: 'source', ...source });
    else output.info(formatJobSource(source));
    return source;
  }

  /** Under the checkout locks: workspaces and sessions, the snapshot, and the job. */
  private async submit(
    loaded: LoadedConfig,
    links: LinkedCheckout[],
    user: UserConfig,
    api: HttpApi,
    command: string,
    profileName: string | null,
    profile: ProfileConfig | null,
    flags: CommonFlags,
    output: Output,
    timeoutMs: number,
  ): Promise<{ job: { id: string; state: string } }> {
    {
      const configDir = path.dirname(loaded.file);
      const requires = profile?.requires ?? [];
      let state = await this.resolveState(loaded, flags, user, output, requires);
      let worker: { id: string; sshHost: string } | null = null;
      {
        const selected = await api.selectWorker({ requires, workspaceId: state.id });
        if (selected?.sshHost) {
          worker = { id: selected.id, sshHost: selected.sshHost };
          state = await this.ensureWorkerSession(state, worker, configDir, loaded.config.ignore, user.identityFile);
        }
      }
      // The main tree first, then each link. Each tree is a checkout with its own workspace and session.
      const trees: SyncedTree[] = [{ name: loaded.config.project, dir: configDir, ignore: loaded.config.ignore, state }];
      for (const link of links) {
        // --workspace names the workspace of the main checkout, not of a link.
        let linkState = await this.resolveState(link.loaded, { ...flags, workspace: undefined }, user, output, requires, worker);
        if (worker) {
          linkState = await this.ensureWorkerSession(linkState, worker, link.dir, link.loaded.config.ignore, user?.identityFile);
        } else if (linkState.sshHost !== state.sshHost) {
          throw new RemoteUnavailable(`link ${link.name} syncs to ${linkState.sshHost}, not to ${state.sshHost}; start a worker, then run again`);
        }
        trees.push({ name: link.name, dir: link.dir, ignore: link.loaded.config.ignore, state: linkState });
      }
      const ssh = this.ssh(state.sshHost, user.identityFile);
      const source = await this.printSource(output, configDir, links);
      const snapshotId = createId('snap');
      const digested = await this.snapshotTrees(ssh, user, trees, snapshotId, output);
      await api.registerSnapshot(state.id, { id: snapshotId, digest: digested.digest, workDir: digested.workDir });
      const created = await api.createJob({
        workspaceId: state.id,
        snapshotId,
        command,
        profile: profileName,
        artifactGlobs: profile?.artifacts ?? [],
        requires,
        priority: flags.priority ? Number(flags.priority) : 0,
        timeoutMs,
        targetWorkerId: worker?.id,
        source,
      });
      return created;
    }
  }

  /**
   * Flush and pause every session, take one snapshot of all trees, and resume every paused session,
   * also when the snapshot fails. The main tree is `trees[0]`. The caller holds the lock of each tree.
   */
  private async snapshotTrees(
    ssh: MutagenSsh,
    user: UserConfig,
    trees: SyncedTree[],
    snapshotId: string,
    output: Output,
  ): Promise<{ digest: string; relPath: string; workDir?: string }> {
    const [main, ...links] = trees;
    for (const tree of trees) await ssh.flush(tree.state.sessionName);
    return this.pauseAndSnapshot(ssh, user, main, links, snapshotId, output);
  }

  private async pauseAndSnapshot(
    ssh: MutagenSsh,
    user: UserConfig,
    main: SyncedTree,
    links: SyncedTree[],
    snapshotId: string,
    output: Output,
  ): Promise<{ digest: string; relPath: string; workDir?: string }> {
    const paused: SyncedTree[] = [];
    try {
      for (const tree of [main, ...links]) {
        await ssh.pause(tree.state.sessionName);
        paused.push(tree);
      }
      return await ssh.snapshot({
        remoteRoot: main.state.remoteRoot,
        snapshotBin: user.snapshotBin ?? 'testbox/app/packages/worker/dist/snapshot-cli.js',
        stagingRel: main.state.stagingRel,
        snapshotId,
        ignore: main.ignore,
        workDir: links.length > 0 ? main.name : undefined,
        links: links.map((link) => ({ name: link.name, stagingRel: link.state.stagingRel, ignore: link.ignore })),
      });
    } finally {
      for (const tree of paused) {
        try {
          await ssh.resume(tree.state.sessionName);
        } catch (err) {
          output.error(err instanceof Error ? err.message : 'mutagen resume failed');
        }
      }
    }
  }

  /** Run over SSH in the synced tree, without the queue. The log file is `.testbox/logs/run_<id>.log`: there is no job. */
  private async direct(
    ssh: MutagenSsh,
    state: WorkspaceState,
    command: string,
    output: Output,
    timeoutMs: number,
  ): Promise<number> {
    const log = this.logFile(state.configDir, createId('run'));
    await log.open();
    try {
      return await this.runDirect(ssh, state, command, output, timeoutMs, log);
    } finally {
      await log.close();
    }
  }

  private async runDirect(
    ssh: MutagenSsh,
    state: WorkspaceState,
    command: string,
    output: Output,
    timeoutMs: number,
    log: LogFile,
  ): Promise<number> {
    const facts = await ssh.probe();
    const fingerprint = await fingerprintFromDirectory(state.configDir, facts);
    const stampPath = path.join(state.configDir, '.testbox', 'direct-fingerprint.json');
    let previous: DependencyFingerprint | null = null;
    try {
      previous = JSON.parse(await readFile(stampPath, 'utf8')) as DependencyFingerprint;
    } catch {
      previous = null;
    }
    if (needsDependencyRefresh(previous, fingerprint)) {
      let hasManifest = true;
      try {
        await readFile(path.join(state.configDir, 'package.json'));
      } catch {
        hasManifest = false;
      }
      if (hasManifest) {
        const root = state.remoteRoot.replace(/^~\//, '');
        const install = `pnpm install --frozen-lockfile --store-dir "$HOME/${root}/cache/pnpm-store"`;
        const installed = await ssh.execIn(state.remoteRoot, state.stagingRel, install, timeoutMs);
        if (installed.stdout) log.write(installed.stdout);
        if (installed.stderr) log.write(installed.stderr);
        if (installed.timedOut) {
          output.summary({ state: 'timed_out', exitCode: null, error: 'timeout during dependency install', exit: ExitCode.Timeout, logFile: log.path });
          return ExitCode.Timeout;
        }
        if (installed.code !== 0) {
          output.line('stderr', installed.stderr.replace(/\n$/, '') || 'dependency install failed');
          output.summary({ state: 'failed', exitCode: installed.code, error: 'dependency install failed', exit: ExitCode.JobFailed, logFile: log.path });
          return ExitCode.JobFailed;
        }
      }
      await mkdir(path.dirname(stampPath), { recursive: true });
      await writeFile(stampPath, JSON.stringify(fingerprint));
    }
    const result = await ssh.execIn(state.remoteRoot, state.stagingRel, command, timeoutMs);
    for (const [stream, text] of [['stdout', result.stdout], ['stderr', result.stderr]] as const) {
      if (!text) continue;
      output.line(stream, text.replace(/\n$/, ''));
      log.write(text);
    }
    if (result.timedOut) {
      output.summary({ state: 'timed_out', exitCode: null, error: 'timeout', exit: ExitCode.Timeout, logFile: log.path });
      return ExitCode.Timeout;
    }
    const code = result.code === 0 ? ExitCode.Pass : ExitCode.JobFailed;
    output.summary({ state: code === 0 ? 'succeeded' : 'failed', exitCode: result.code, exit: code, logFile: log.path });
    return code;
  }

  private async follow(api: HttpApi, jobId: string, output: Output, log: LogFile | null): Promise<number> {
    let terminal: { state: string; exitCode: number | null; error: string | null } | null = null;
    let detached = false;
    const controller = new AbortController();
    await log?.open();
    const dispose = attachInterrupt({
      signals: this.io.signals,
      isTTY: this.io.isTTY,
      prompt: this.io.prompt,
      cancel: () => {
        void api.cancel(jobId).catch(() => undefined);
      },
      detach: () => {
        detached = true;
        controller.abort();
      },
    });
    try {
      await api.stream(
        jobId,
        (event, data) => {
          const parsed = JSON.parse(data) as {
            stream?: 'stdout' | 'stderr';
            line?: string;
            state?: string;
            exitCode?: number | null;
            error?: string | null;
          };
          if (event === 'log' && parsed.stream && parsed.line !== undefined) {
            output.line(parsed.stream, parsed.line);
            log?.write(parsed.line);
          }
          if (event === 'state' && parsed.state) {
            output.event({ type: 'status', state: parsed.state, jobId });
          }
          if (event === 'done' && parsed.state) {
            terminal = {
              state: parsed.state,
              exitCode: parsed.exitCode ?? null,
              error: parsed.error ?? null,
            };
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!detached && !(err instanceof Error && err.name === 'AbortError')) throw err;
    } finally {
      dispose();
      await log?.close();
      if (log?.error) output.info(log.error);
    }
    if (detached) {
      output.summary(detachedSummary(jobId, log?.path));
      return ExitCode.Pass;
    }
    if (!terminal) {
      const job = await api.getJob(jobId);
      terminal = { state: job.job.state, exitCode: job.job.exitCode, error: job.job.error };
    }
    const exit = exitCodeForJob(terminal.state as JobState);
    output.summary({
      jobId,
      state: terminal.state,
      exitCode: terminal.exitCode,
      error: terminal.error,
      exit,
      logFile: log?.path,
    });
    return exit;
  }

  private logFile(configDir: string, id: string): LogFile {
    return new LogFile(path.join(configDir, '.testbox', 'logs', `${id}.log`));
  }

  /** The log file for a job id, when the current directory is in a repo with testbox.yml; else none. */
  private async logFileNearConfig(jobId: string): Promise<LogFile | null> {
    try {
      const loaded = await loadRepoConfig(this.io.cwd);
      return this.logFile(path.dirname(loaded.file), jobId);
    } catch {
      return null;
    }
  }

  /**
   * One Mutagen session per worker. The session that is flushed is the worker
   * the scheduler will pin the job to, so the snapshot and the run share a disk.
   */
  private async ensureWorkerSession(
    state: WorkspaceState,
    worker: { id: string; sshHost: string },
    sourceDir: string,
    ignore: string[],
    identityFile?: string,
  ): Promise<WorkspaceState> {
    const sessions = { ...(state.sessions ?? {}) };
    const existing = sessions[worker.id];
    const ssh = this.ssh(worker.sshHost, identityFile);
    if (existing && existing.sshHost === worker.sshHost) {
      const next: WorkspaceState = {
        ...state,
        sshHost: worker.sshHost,
        sessionName: existing.sessionName,
        workerId: worker.id,
        sessions,
      };
      await writeWorkspaceState(state.configDir, next);
      return next;
    }
    const name = sessionName(state.project, state.id, worker.id);
    // The worker moved to another host: its old session must go before the name is used again.
    if (existing) await terminateAll(ssh, [existing.sessionName]);
    await ssh.ensureStaging(state.remoteRoot, state.stagingRel);
    await ssh.create({
      name,
      source: sourceDir,
      destination: mutagenDestination(worker.sshHost, state.remoteRoot, state.stagingRel),
      ignore,
    });
    sessions[worker.id] = { sessionName: name, sshHost: worker.sshHost };
    const next: WorkspaceState = {
      ...state,
      sshHost: worker.sshHost,
      sessionName: name,
      workerId: worker.id,
      sessions,
    };
    await writeWorkspaceState(state.configDir, next);
    return next;
  }

  /**
   * The workspace of this checkout. When there is none yet (or the state file was
   * copied from another checkout), make one, as `testbox start` would.
   */
  private async resolveState(
    loaded: LoadedConfig,
    flags: CommonFlags,
    user: UserConfig | null,
    output: Output,
    requires: string[],
    worker?: { id: string; sshHost: string } | null,
  ): Promise<WorkspaceState> {
    const config = loaded.config;
    const dir = path.dirname(loaded.file);
    const stored = await readWorkspaceState(dir);
    const state = stored && stored.configDir === dir ? stored : null;
    if (flags.workspace && user && !flags.direct) {
      const workspace = await this.api(user).getWorkspace(flags.workspace);
      return {
        id: workspace.id,
        project: workspace.project,
        sessionName: state?.sessionName ?? sessionName(config.project, workspace.id),
        stagingRel: workspace.stagingRel,
        sshHost: flags.sshHost || state?.sshHost || user.sshHost || config.sshHost || '',
        remoteRoot: state?.remoteRoot ?? user.remoteRoot ?? '~/testbox',
        direct: false,
        configDir: dir,
      };
    }
    if (!state) {
      output.info('no workspace for this checkout yet; starting one');
      const started = await this.createWorkspace(loaded, user, flags, output, requires, worker);
      if (!this.json) output.info(`started workspace ${started.state.id}`);
      return started.state;
    }
    if (!state.sshHost) throw new Error('workspace is missing an ssh host');
    return state;
  }

  private async requireUser(direct: boolean): Promise<UserConfig | null> {
    const user = await readUserConfig(this.io.homeDir);
    if (!direct && (!user?.token || !user.apiUrl)) {
      throw new CliApiError('not logged in', 'AUTH', 401);
    }
    return user;
  }

  private api(user: UserConfig): HttpApi {
    return new HttpApi(user.apiUrl, user.token, this.io.fetchImpl);
  }

  private ssh(host: string, identityFile?: string): MutagenSsh {
    return new MutagenSsh(this.io.remote, host, identityFile);
  }

  private timeoutMs(flags: CommonFlags): number {
    const seconds = flags.timeout ? Number(flags.timeout) : 30 * 60;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError('invalid --timeout: pass a number of seconds above 0');
    return Math.round(seconds * 1000);
  }

  private fail(output: Output, err: unknown): number {
    const message = err instanceof Error ? err.message : 'failed';
    const code = exitCodeForFailure(err);
    output.failure(message, code);
    return code;
  }
}

/** The CLI exit code for an error thrown before or outside a job. */
export function exitCodeForFailure(err: unknown): number {
  if (err instanceof SyncError) return ExitCode.SyncError;
  if (err instanceof RemoteUnavailable) return ExitCode.NoWorker;
  if (err instanceof UsageError || err instanceof ConfigError || err instanceof LinkError) return ExitCode.Usage;
  return exitCodeForCliError(err) ?? ExitCode.JobFailed;
}

/**
 * The links of a job. verify: the links of the profile; `--link` only changes where one is.
 * run: the names given with `--link`.
 */
function jobLinkNames(project: string, profileName: string | null, profile: ProfileConfig | null, overrides: Map<string, string>): string[] {
  if (!profile) {
    // The same rules as `links` in testbox.yml: the main tree is the folder <project>, and the API caps the count.
    // Case does not count: a Mac worker's disk can be case-insensitive, so App and app are one folder.
    const taken = [...overrides.keys()].find((name) => name.toLowerCase() === project.toLowerCase());
    if (taken) throw new UsageError(`--link ${taken}: a link cannot have the project name ${project}`);
    if (overrides.size > JOB_SOURCE_MAX_LINKS) throw new UsageError(`--link: at most ${JOB_SOURCE_MAX_LINKS} links`);
    return [...overrides.keys()];
  }
  for (const name of overrides.keys()) {
    if (!profile.links.includes(name)) {
      const known = profile.links.length ? `its links are: ${profile.links.join(', ')}` : 'it has no links';
      throw new UsageError(`--link ${name}: profile ${profileName ?? ''} has no link ${name}; ${known}`);
    }
  }
  return profile.links;
}

/** Stable id for one checkout directory, so two checkouts of a repo get two folders on the worker. */
function checkoutId(dir: string): string {
  return createHash('sha256').update(dir).digest('hex').slice(0, 12);
}

/** Local roots other than `configDir` with a testbox session into the worker folder `stagingRel`. */
function otherRootsSyncingTo(sessions: MutagenSessionInfo[], stagingRel: string, configDir: string): string[] {
  const roots = new Set<string>();
  for (const session of sessions) {
    if (!session.name.startsWith('testbox-') || session.alphaPath === configDir) continue;
    if (session.betaUrl.endsWith(`/${stagingRel}`)) roots.add(session.alphaPath);
  }
  return [...roots];
}

/** The summary when the CLI stops following a job that still runs: say how to find it again. */
function detachedSummary(jobId: string, logFile?: string): Summary {
  return {
    jobId,
    state: 'detached',
    exitCode: null,
    exit: ExitCode.Pass,
    logFile,
    hint: `the job continues on the worker: testbox logs ${jobId} --follow, or testbox status ${jobId}`,
  };
}

async function findWorkspace(api: HttpApi, id: string): Promise<{ id: string; stagingRel: string } | null> {
  try {
    return await api.getWorkspace(id);
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) return null;
    throw err;
  }
}

async function terminateAll(mutagen: MutagenSsh, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await mutagen.terminate(name);
    } catch (err) {
      if (!(err instanceof SyncError)) throw err;
    }
  }
}
