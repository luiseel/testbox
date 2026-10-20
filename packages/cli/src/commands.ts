import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  createId,
  ExitCode,
  exitCodeForJob,
  fingerprintFromDirectory,
  loadRepoConfig,
  needsDependencyRefresh,
  sessionName,
  type DependencyFingerprint,
  type JobState,
  type ProfileConfig,
  type TestboxConfig,
} from '@testbox/shared';
import { CliApiError, exitCodeForCliError, HttpApi } from './api-client';
import {
  readUserConfig,
  readWorkspaceState,
  removeWorkspaceState,
  writeUserConfig,
  writeWorkspaceState,
  type UserConfig,
  type WorkerSession,
  type WorkspaceState,
} from './config-store';
import { attachInterrupt } from './interrupt';
import { Output, type TextSink } from './output';
import { mutagenDestination, MutagenSsh, RemoteUnavailable, SyncError, type RemoteRunner } from './remote';

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
}

export class TestboxApp {
  constructor(
    private readonly io: CliIO,
    private readonly json: boolean,
  ) {}

  private out(): Output {
    return new Output(this.json, this.io.stdout, this.io.stderr);
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
      output.error(err instanceof Error ? err.message : 'login failed');
      return exitCodeForCliError(err) ?? ExitCode.Auth;
    }
    await writeUserConfig(this.io.homeDir, config);
    output.summary({ ok: true, exitCode: 0 });
    return ExitCode.Pass;
  }

  async start(flags: CommonFlags): Promise<number> {
    const output = this.out();
    try {
      const loaded = await loadRepoConfig(this.io.cwd);
      const user = await this.requireUser(flags.direct === true);
      const direct = flags.direct === true;
      const configDir = path.dirname(loaded.file);
      const project = loaded.config.project;
      const previous = await readWorkspaceState(configDir);
      let sshHost = flags.sshHost || user?.sshHost || loaded.config.sshHost;
      const remoteRoot = user?.remoteRoot ?? '~/testbox';
      // Mutagen runs on this machine; the ssh host does not matter for list and terminate.
      const mutagen = this.ssh(sshHost ?? '', user?.identityFile);
      const previousNames = previous ? workspaceSessionNames(previous) : [];
      const live = new Set(previousNames.length > 0 ? (await mutagen.list()).map((session) => session.name) : []);
      let id = checkoutId(configDir);
      let stagingRel = `workspaces/local/${project}/${id}`;
      let workerId: string | undefined;
      let reused: WorkspaceState | null = null;
      if (!direct) {
        if (!user) return ExitCode.Auth;
        const api = this.api(user);
        const existing = previous && !previous.direct ? await findWorkspace(api, previous.id) : null;
        if (existing) {
          id = existing.id;
          stagingRel = existing.stagingRel;
          reused = previous;
        } else {
          // The workspace is gone on the API; its sessions are stale.
          await terminateAll(mutagen, previousNames);
          live.clear();
          const created = await api.createWorkspace(project);
          id = created.id;
          stagingRel = created.stagingRel;
        }
        const selected = await api.selectWorker({ requires: [], workspaceId: id });
        if (selected?.sshHost) {
          sshHost = selected.sshHost;
          workerId = selected.id;
        }
      }
      if (!sshHost) {
        output.error('ssh host is required (testbox.yml sshHost, login, or --ssh-host)');
        return ExitCode.JobFailed;
      }
      // Keep the live sessions of a reused workspace. Keep the session for this host if it is alive.
      const sessions: Record<string, WorkerSession> = {};
      for (const [key, session] of Object.entries(reused?.sessions ?? {})) {
        if (live.has(session.sessionName)) sessions[key] = session;
      }
      const current = workerId
        ? sessions[workerId]
        : reused && { sessionName: reused.sessionName, sshHost: reused.sshHost };
      let name = sessionName(project, id, workerId);
      if (current && current.sshHost === sshHost && live.has(current.sessionName)) {
        name = current.sessionName;
      } else {
        const kept = new Set(Object.values(sessions).map((session) => session.sessionName));
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
      if (workerId) sessions[workerId] = { sessionName: name, sshHost };
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
      await writeWorkspaceState(configDir, state);
      output.summary({ jobId: id, state: 'started', exitCode: 0 });
      if (!this.json) {
        if (reused) output.info(`reused workspace ${id}`);
        output.info(`session ${name}`);
      }
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  async stop(): Promise<number> {
    const output = this.out();
    try {
      const loaded = await loadRepoConfig(this.io.cwd);
      const state = await readWorkspaceState(path.dirname(loaded.file));
      if (!state) {
        output.error('no workspace; run testbox start');
        return ExitCode.JobFailed;
      }
      const user = await readUserConfig(this.io.homeDir);
      const ssh = this.ssh(state.sshHost, user?.identityFile);
      const names = new Set<string>([
        state.sessionName,
        ...Object.values(state.sessions ?? {}).map((session) => session.sessionName),
      ]);
      for (const name of names) {
        try {
          await ssh.terminate(name);
        } catch (err) {
          if (!(err instanceof SyncError)) throw err;
        }
      }
      if (!state.direct && user) {
        try {
          await this.api(user).deleteWorkspace(state.id);
        } catch (err) {
          if (!(err instanceof CliApiError) || err.status !== 404) throw err;
        }
      }
      await removeWorkspaceState(path.dirname(loaded.file));
      output.summary({ jobId: state.id, state: 'stopped', exitCode: 0 });
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  async run(command: string, flags: CommonFlags): Promise<number> {
    return this.execute(command, flags.profile ?? null, null, flags);
  }

  async verify(profileName: string, flags: CommonFlags): Promise<number> {
    const output = this.out();
    let loaded;
    try {
      loaded = await loadRepoConfig(this.io.cwd);
    } catch (err) {
      return this.fail(output, err);
    }
    const profile = loaded.config.profiles[profileName];
    if (!profile) {
      output.error(`unknown profile ${profileName}`);
      return ExitCode.JobFailed;
    }
    return this.execute(profile.cmd, profileName, profile, flags);
  }

  async status(jobId: string): Promise<number> {
    const output = this.out();
    try {
      const user = await this.requireUser(false);
      if (!user) return ExitCode.Auth;
      const { job } = await this.api(user).getJob(jobId);
      output.summary({ jobId: job.id, state: job.state, exitCode: job.exitCode, error: job.error });
      return exitCodeForJob(job.state);
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
        output.summary({ jobId, state: job.job.state, exitCode: job.job.exitCode, error: job.job.error });
        return exitCodeForJob(job.job.state);
      }
      return this.follow(api, jobId, output);
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
      output.summary({ jobId: job.id, state: job.state, exitCode: job.exitCode, error: job.error });
      return job.state === 'cancelled' ? ExitCode.Cancelled : exitCodeForJob(job.state);
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
      output.summary({ jobId, state: 'artifacts', exitCode: 0 });
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
    const output = this.out();
    try {
      const loaded = await loadRepoConfig(this.io.cwd);
      const user = await this.requireUser(flags.direct === true);
      let state = await this.resolveState(loaded.file, loaded.config, flags, user);
      let targetWorkerId: string | undefined;
      if (!flags.direct && user) {
        const selected = await this.api(user).selectWorker({
          requires: profile?.requires ?? [],
          workspaceId: state.id,
        });
        if (selected?.sshHost) {
          state = await this.ensureWorkerSession(
            state,
            { id: selected.id, sshHost: selected.sshHost },
            path.dirname(loaded.file),
            loaded.config.ignore,
            user.identityFile,
          );
          targetWorkerId = selected.id;
        }
      }
      const ssh = this.ssh(state.sshHost, user?.identityFile);
      await ssh.flush(state.sessionName);
      if (flags.direct) {
        return this.direct(ssh, state, command, output, flags);
      }
      if (!user) return ExitCode.Auth;
      const snapshotId = createId('snap');
      await ssh.pause(state.sessionName);
      let digested: { digest: string; relPath: string } | undefined;
      try {
        digested = await ssh.snapshot({
          remoteRoot: state.remoteRoot,
          snapshotBin: user.snapshotBin ?? 'testbox/app/packages/worker/dist/snapshot-cli.js',
          stagingRel: state.stagingRel,
          snapshotId,
          ignore: loaded.config.ignore,
        });
      } finally {
        try {
          await ssh.resume(state.sessionName);
        } catch (err) {
          output.error(err instanceof Error ? err.message : 'mutagen resume failed');
        }
      }
      if (!digested) throw new SyncError('snapshot failed');
      const api = this.api(user);
      await api.registerSnapshot(state.id, { id: snapshotId, digest: digested.digest });
      const created = await api.createJob({
        workspaceId: state.id,
        snapshotId,
        command,
        profile: profileName,
        artifactGlobs: profile?.artifacts ?? [],
        requires: profile?.requires ?? [],
        priority: flags.priority ? Number(flags.priority) : 0,
        timeoutMs: this.timeoutMs(flags),
        targetWorkerId,
      });
      output.event({ type: 'status', state: created.job.state, jobId: created.job.id });
      if (flags.detach) {
        output.summary({ jobId: created.job.id, state: created.job.state, exitCode: null });
        return ExitCode.Pass;
      }
      return this.follow(api, created.job.id, output);
    } catch (err) {
      return this.fail(output, err);
    }
  }

  private async direct(
    ssh: MutagenSsh,
    state: WorkspaceState,
    command: string,
    output: Output,
    flags: CommonFlags,
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
        const installed = await ssh.execIn(state.remoteRoot, state.stagingRel, install, this.timeoutMs(flags));
        if (installed.timedOut) return ExitCode.Timeout;
        if (installed.code !== 0) {
          output.error(installed.stderr || 'dependency install failed');
          return ExitCode.JobFailed;
        }
      }
      await mkdir(path.dirname(stampPath), { recursive: true });
      await writeFile(stampPath, JSON.stringify(fingerprint));
    }
    const result = await ssh.execIn(state.remoteRoot, state.stagingRel, command, this.timeoutMs(flags));
    if (result.stdout) output.line('stdout', result.stdout.replace(/\n$/, ''));
    if (result.stderr) output.line('stderr', result.stderr.replace(/\n$/, ''));
    if (result.timedOut) {
      output.summary({ state: 'timed_out', exitCode: null, error: 'timeout' });
      return ExitCode.Timeout;
    }
    const code = result.code === 0 ? ExitCode.Pass : ExitCode.JobFailed;
    output.summary({ state: code === 0 ? 'succeeded' : 'failed', exitCode: result.code });
    return code;
  }

  private async follow(api: HttpApi, jobId: string, output: Output): Promise<number> {
    let terminal: { state: string; exitCode: number | null; error: string | null } | null = null;
    let detached = false;
    const controller = new AbortController();
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
          if (event === 'log' && parsed.stream && parsed.line !== undefined) output.line(parsed.stream, parsed.line);
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
    }
    if (detached) {
      output.summary({ jobId, state: 'detached', exitCode: 0 });
      return ExitCode.Pass;
    }
    if (!terminal) {
      const job = await api.getJob(jobId);
      terminal = { state: job.job.state, exitCode: job.job.exitCode, error: job.job.error };
    }
    output.summary({
      jobId,
      state: terminal.state,
      exitCode: terminal.exitCode,
      error: terminal.error,
    });
    return exitCodeForJob(terminal.state as JobState);
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

  private async resolveState(
    configFile: string,
    config: TestboxConfig,
    flags: CommonFlags,
    user: UserConfig | null,
  ): Promise<WorkspaceState> {
    const dir = path.dirname(configFile);
    const state = await readWorkspaceState(dir);
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
    if (!state) throw new Error('no workspace; run testbox start');
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
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('invalid --timeout');
    return Math.round(seconds * 1000);
  }

  private fail(output: Output, err: unknown): number {
    if (err instanceof SyncError) {
      output.error(err.message);
      return ExitCode.SyncError;
    }
    if (err instanceof RemoteUnavailable) {
      output.error(err.message);
      return ExitCode.NoWorker;
    }
    const mapped = exitCodeForCliError(err);
    output.error(err instanceof Error ? err.message : 'failed');
    return mapped ?? ExitCode.JobFailed;
  }
}

/** Stable id for one checkout directory, so two checkouts of a repo get two folders on the worker. */
function checkoutId(dir: string): string {
  return createHash('sha256').update(dir).digest('hex').slice(0, 12);
}

function workspaceSessionNames(state: WorkspaceState): string[] {
  const names = new Set<string>([state.sessionName]);
  for (const session of Object.values(state.sessions ?? {})) names.add(session.sessionName);
  return [...names].filter((name) => name.length > 0);
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
