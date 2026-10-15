import { access, readdir, readFile, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildSshArgs, ExitCode, loadRepoConfig } from '@testbox/shared';
import { CliApiError, HttpApi } from './api-client';
import { TestboxApp, type CliIO } from './commands';
import { readUserConfig, type UserConfig } from './config-store';

interface Check {
  ok: boolean;
  label: string;
  fix?: string;
}

interface Worker {
  id: string;
  healthy: boolean;
  labels: string[];
  sshHost?: string | null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** `testbox setup`, `testbox doctor`, and `testbox init`: the developer side. */
export class DeveloperApp {
  constructor(
    private readonly io: CliIO,
    private readonly json: boolean,
  ) {}

  /** Install Mutagen, log in, make an SSH key, then check everything. */
  async setup(apiUrl: string, token: string): Promise<number> {
    const say = (text: string) => this.io.stderr.write(`${text}\n`);
    if (!(await this.hasMutagen())) {
      say('installing Mutagen');
      const brew = await this.io.remote.run('brew', ['install', 'mutagen-io/mutagen/mutagen'], {
        onStderr: (text) => this.io.stderr.write(text),
      });
      if (brew.code !== 0) {
        say('could not install Mutagen with Homebrew. Install it from https://mutagen.io/documentation/introduction/installation, then run testbox setup again.');
        return ExitCode.JobFailed;
      }
    }
    const login = await new TestboxApp(this.io, this.json).login(token, apiUrl);
    if (login !== ExitCode.Pass) return login;
    const key = await this.ensureSshKey();
    say(`SSH key: ${key.file}`);
    return this.doctor();
  }

  /** Check each part a job needs, and print the fix for each problem. */
  async doctor(): Promise<number> {
    const checks: Check[] = [];
    const add = (check: Check) => {
      checks.push(check);
      if (this.json) {
        this.io.stdout.write(`${JSON.stringify({ type: 'check', ...check })}\n`);
      } else {
        this.io.stdout.write(`${check.ok ? '✓' : '✗'} ${check.label}\n`);
        if (!check.ok && check.fix) this.io.stdout.write(`    fix: ${check.fix}\n`);
      }
    };

    const user = await readUserConfig(this.io.homeDir);
    if (!user?.token || !user.apiUrl) {
      add({ ok: false, label: 'logged in', fix: 'ask an admin for a setup command (testbox admin add-user <name>), then run it' });
      return ExitCode.Auth;
    }
    const api = new HttpApi(user.apiUrl, user.token, this.io.fetchImpl);
    if (!(await api.healthy())) {
      add({
        ok: false,
        label: `API at ${user.apiUrl}`,
        fix: `not on the office LAN? Turn on Twingate; it needs a resource for ${new URL(user.apiUrl).host}`,
      });
      return ExitCode.NoWorker;
    }
    add({ ok: true, label: `API at ${user.apiUrl}` });
    try {
      const me = await api.me();
      add({ ok: true, label: `logged in as ${me.name}` });
    } catch (err) {
      if (err instanceof CliApiError && err.status === 401) {
        add({ ok: false, label: 'token', fix: 'ask an admin for a new token: testbox admin add-user <your name>' });
        return ExitCode.Auth;
      }
      throw err;
    }
    add(
      (await this.hasMutagen())
        ? { ok: true, label: 'Mutagen' }
        : { ok: false, label: 'Mutagen', fix: 'brew install mutagen-io/mutagen/mutagen' },
    );

    const workers = (await api.listWorkers()) as Worker[];
    if (workers.length === 0) {
      add({ ok: false, label: 'workers', fix: 'an admin adds one: testbox admin add-worker <user@host>' });
    }
    const key = await this.publicKey();
    for (const worker of workers) {
      for (const check of await this.checkWorker(worker, user, key)) add(check);
    }
    for (const check of await this.checkProfiles(workers)) add(check);
    return checks.every((check) => check.ok) ? ExitCode.Pass : ExitCode.JobFailed;
  }

  /** Write a starting testbox.yml from what the repo contains. */
  async init(force: boolean): Promise<number> {
    const file = path.join(this.io.cwd, 'testbox.yml');
    if (!force && (await exists(file))) {
      this.io.stderr.write('testbox.yml exists; pass --force to replace it\n');
      return ExitCode.JobFailed;
    }
    const detected = await detectProfiles(this.io.cwd);
    await writeFile(file, renderConfig(path.basename(this.io.cwd), detected));
    if (detected.profiles.length === 0) {
      this.io.stderr.write('wrote testbox.yml with an example profile; edit its command\n');
    } else {
      this.io.stderr.write(`wrote testbox.yml with ${detected.profiles.map((profile) => profile.name).join(', ')}\n`);
    }
    this.io.stderr.write('next: testbox start, then testbox verify <profile>\n');
    return ExitCode.Pass;
  }

  private async checkWorker(worker: Worker, user: UserConfig, key: string | null): Promise<Check[]> {
    const checks: Check[] = [];
    const host = worker.sshHost ?? '';
    checks.push(
      worker.healthy
        ? { ok: true, label: `${worker.id} is up (${worker.labels.filter((label) => !label.startsWith('worker:')).join(', ')})` }
        : {
            ok: false,
            label: `${worker.id} sends no heartbeat`,
            fix: `an admin runs: testbox admin add-worker ${host || '<user@host>'} (on a Mac, also allow Local Network for node)`,
          },
    );
    if (!host) return checks;
    const root = (user.remoteRoot ?? '~/testbox').replace(/^~\//, '');
    const probe = [
      `test -x "$HOME/${root}/bin/node"`,
      `test -x "$HOME/${root}/bin/flock"`,
      `test -f "$HOME/${root}/app/packages/worker/dist/snapshot-cli.js"`,
    ].join(' && ');
    const result = await this.io.remote.run('ssh', buildSshArgs(host, probe, user.identityFile), { timeoutMs: 20_000 });
    if (result.code === 0) {
      checks.push({ ok: true, label: `SSH to ${host}` });
    } else if (result.code === 255 || result.code === null || result.timedOut) {
      const denied = /permission denied/i.test(result.stderr);
      checks.push({
        ok: false,
        label: `SSH to ${host}`,
        fix: denied
          ? `send this to an admin: testbox admin authorize '${key ?? '<your ~/.ssh/id_ed25519.pub>'}'`
          : `cannot reach ${host}. Not on the office LAN? Turn on Twingate; it needs a resource for ${host.split('@').pop()} port 22`,
      });
    } else {
      checks.push({
        ok: false,
        label: `snapshot tools on ${host}`,
        fix: `an admin runs: testbox admin add-worker ${host}`,
      });
    }
    return checks;
  }

  private async checkProfiles(workers: Worker[]): Promise<Check[]> {
    let config;
    try {
      config = (await loadRepoConfig(this.io.cwd)).config;
    } catch {
      return [];
    }
    return Object.entries(config.profiles).map(([name, profile]) => {
      const fits = workers.filter((worker) => profile.requires.every((label) => worker.labels.includes(label)));
      const requires = profile.requires.length ? ` (requires ${profile.requires.join(', ')})` : '';
      if (fits.some((worker) => worker.healthy)) return { ok: true, label: `profile ${name}${requires}` };
      return {
        ok: false,
        label: `profile ${name}${requires}`,
        fix: fits.length
          ? `only ${fits.map((worker) => worker.id).join(', ')} can run it, and it is down`
          : 'no worker has these labels; change requires, or an admin adds a worker with --labels',
      };
    });
  }

  private async hasMutagen(): Promise<boolean> {
    const result = await this.io.remote.run('mutagen', ['version'], { timeoutMs: 10_000 });
    return result.code === 0;
  }

  private async publicKey(): Promise<string | null> {
    for (const name of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
      try {
        return (await readFile(path.join(this.io.homeDir, '.ssh', name), 'utf8')).trim();
      } catch {
        // try the next one
      }
    }
    return null;
  }

  private async ensureSshKey(): Promise<{ file: string; created: boolean }> {
    const file = path.join(this.io.homeDir, '.ssh', 'id_ed25519');
    if (await this.publicKey()) return { file: `${file}.pub`, created: false };
    const result = await this.io.remote.run('ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      file,
      '-C',
      `testbox ${os.userInfo().username}@${os.hostname()}`,
    ]);
    if (result.code !== 0) throw new Error(`ssh-keygen failed: ${result.stderr.trim()}`);
    return { file: `${file}.pub`, created: true };
  }
}

interface DetectedProfile {
  name: string;
  command: string;
  requires: string[];
  resources: 'light' | 'exclusive';
  note?: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'DerivedData', 'Pods']);
const BASE_IGNORE = ['.git', 'node_modules', '.env', '.env.*', '.testbox', '**/*.log'];

async function subdirs(root: string, rel: string): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
    .map((entry) => (rel ? `${rel}/${entry.name}` : entry.name));
}

/** Find test commands in the repo root and two levels below it (e.g. client/swift-client). */
export async function detectProfiles(root: string): Promise<{ profiles: DetectedProfile[]; ignore: string[] }> {
  const mise = (await Promise.all(['mise.toml', '.mise.toml', '.tool-versions'].map((name) => exists(path.join(root, name))))).some(Boolean);
  const toolchain = mise ? ['mise'] : [];
  const level1 = await subdirs(root, '');
  const dirs = ['', ...level1];
  for (const dir of level1) dirs.push(...(await subdirs(root, dir)));
  const ignore = new Set(BASE_IGNORE);
  const profiles: DetectedProfile[] = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    const found: (Omit<DetectedProfile, 'name'> & { kind: string })[] = [];
    const has = (name: string) => exists(path.join(abs, name));
    const prefix = dir ? `cd ${dir} && ` : '';
    if (await has('package.json')) {
      const pkg = JSON.parse(await readFile(path.join(abs, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) {
        const runner = (await has('pnpm-lock.yaml')) ? 'pnpm test' : (await has('yarn.lock')) ? 'yarn test' : 'npm test';
        found.push({ kind: 'test', command: `${prefix}${runner}`, requires: toolchain, resources: 'light' });
        ignore.add(dir ? `${dir}/node_modules` : 'node_modules').add(dir ? `${dir}/dist` : 'dist');
      }
    }
    if (await has('gradlew')) {
      found.push({
        kind: 'gradle',
        command: `${prefix}./gradlew --no-daemon test`,
        requires: toolchain,
        resources: 'light',
        note: mise ? undefined : 'needs Java on the worker; pin it in mise.toml and require mise',
      });
      for (const out of ['.gradle', 'build', 'bin']) ignore.add(dir ? `${dir}/${out}` : out);
    }
    if (await has('Package.swift')) {
      // Swift Build hangs in a LaunchAgent session; the native build system does not.
      found.push({ kind: 'swift', command: `${prefix}swift test --build-system native`, requires: ['macos'], resources: 'light' });
      ignore.add(dir ? `${dir}/.build` : '.build');
    }
    const xcode = (await readdir(abs)).find((name) => name.endsWith('.xcworkspace') || name.endsWith('.xcodeproj'));
    if (xcode) {
      const scheme = xcode.replace(/\.(xcworkspace|xcodeproj)$/, '');
      const flag = xcode.endsWith('.xcworkspace') ? '-workspace' : '-project';
      found.push({
        kind: 'ios',
        command: `${prefix}xcodebuild test ${flag} ${xcode} -scheme ${scheme} -destination 'platform=iOS Simulator,name=iPhone 16'`,
        requires: ['macos', 'xcode', 'ios-simulator'],
        resources: 'exclusive',
        note: 'check the scheme and the simulator name',
      });
      ignore.add('DerivedData');
    }
    if (await has('go.mod')) found.push({ kind: 'go', command: `${prefix}go test ./...`, requires: toolchain, resources: 'light' });
    if (await has('Cargo.toml')) {
      found.push({ kind: 'cargo', command: `${prefix}cargo test`, requires: toolchain, resources: 'light' });
      ignore.add(dir ? `${dir}/target` : 'target');
    }
    if (await has('pyproject.toml')) {
      found.push({ kind: 'pytest', command: `${prefix}python -m pytest`, requires: toolchain, resources: 'light' });
      ignore.add('.venv').add('**/__pycache__');
    }
    for (const entry of found) {
      const base = dir ? path.basename(dir) : '';
      let name = base ? (found.length === 1 ? base : `${base}-${entry.kind}`) : entry.kind;
      if (profiles.some((profile) => profile.name === name)) name = `${dir.replace(/\//g, '-')}-${entry.kind}`;
      profiles.push({ name: name.replace(/[^A-Za-z0-9_-]/g, '-'), command: entry.command, requires: entry.requires, resources: entry.resources, note: entry.note });
    }
  }
  return { profiles, ignore: [...ignore] };
}

function yamlString(value: string): string {
  return /^[A-Za-z0-9 ./_@=-]+$/.test(value) ? value : JSON.stringify(value);
}

export function renderConfig(dirName: string, detected: { profiles: DetectedProfile[]; ignore: string[] }): string {
  const project = dirName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'project';
  const lines = [
    `project: ${project}`,
    '# Not synced to the worker. This list replaces the default list.',
    'ignore:',
    ...detected.ignore.map((entry) => `  - ${yamlString(entry)}`),
    'profiles:',
  ];
  const profiles = detected.profiles.length
    ? detected.profiles
    : [{ name: 'test', command: 'echo "replace with your test command"', requires: [], resources: 'light' as const, note: 'edit this' }];
  for (const profile of profiles) {
    if (profile.note) lines.push(`  # ${profile.note}`);
    lines.push(`  ${profile.name}:`, `    command: ${yamlString(profile.command)}`, `    resources: ${profile.resources}`);
    if (profile.requires.length) lines.push(`    requires: [${profile.requires.join(', ')}]`);
  }
  return `${lines.join('\n')}\n`;
}
