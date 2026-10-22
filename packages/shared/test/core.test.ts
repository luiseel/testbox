import { execFile } from 'child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_IGNORE,
  ExitCode,
  IllegalTransitionError,
  JOB_STATES,
  assertSafeSegment,
  assertTransition,
  buildFingerprint,
  buildShellSpawn,
  buildSshArgs,
  commandLineHasJob,
  canTransition,
  collectLockfiles,
  ensureDependencies,
  exitCodeForApiError,
  exitCodeForJob,
  fingerprintDigest,
  formatJobSource,
  hintForExitCode,
  isTerminal,
  loadRepoConfig,
  matchGlob,
  needsDependencyRefresh,
  parseTestboxConfig,
  parseWorkerConfig,
  quoteShellArg,
  redact,
  remoteBash,
  remoteHomeScript,
  snapshotRel,
  stagingRel,
  type JobState,
} from '../src';

const exec = promisify(execFile);

describe('job states', () => {
  it('allows the documented lifecycle and rejects anything else', () => {
    expect(canTransition('queued', 'assigned')).toBe(true);
    expect(canTransition('assigned', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(true);
    expect(canTransition('running', 'timed_out')).toBe(true);
    expect(canTransition('queued', 'cancelled')).toBe(true);
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
    expect(isTerminal('timed_out')).toBe(true);
    expect(() => assertTransition('succeeded', 'running')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('cancelled', 'queued')).toThrow(/never re-executed/);
  });
});

describe('shell safety', () => {
  it('passes a command as one bash argv', () => {
    expect(buildShellSpawn('pnpm test; echo hi $(whoami)')).toEqual({
      file: 'bash',
      args: ['-c', 'pnpm test; echo hi $(whoami)'],
    });
  });

  it('marks a job shell in $0 and keeps bash as the leader', () => {
    expect(buildShellSpawn('sleep 30', 'job_abc')).toEqual({
      file: 'bash',
      args: ['-c', 'sleep 30\nexit "$?"', 'testbox-job:job_abc'],
    });
    expect(() => buildShellSpawn('true', 'job x')).toThrow(/unsafe job id/);
    const ps = '  12   ??  Ss  0:00.01 bash -c sleep 30\nexit "$?" testbox-job:job_abc PATH=/bin';
    expect(commandLineHasJob(ps, 'job_abc')).toBe(true);
    expect(commandLineHasJob(ps, 'job_ab')).toBe(false);
    expect(commandLineHasJob('  12 sleep 30 TESTBOX_JOB_ID=job_abc HOME=/x', 'job_abc')).toBe(true);
  });

  it('quotes a payload so it cannot break out of the wrapper', async () => {
    const marker = path.join(os.tmpdir(), `testbox-inject-${process.pid}`);
    await rm(marker, { force: true });
    const remote = remoteBash(`'; touch ${marker}; printf %s pwned; echo '`);
    await exec('sh', ['-c', remote]).catch(() => undefined);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('runs a quoted command under a home-relative directory', async () => {
    const dir = `tbq${process.pid}`;
    const abs = path.join(os.homedir(), dir);
    await rm(abs, { recursive: true, force: true });
    const { mkdir } = await import('fs/promises');
    await mkdir(abs, { recursive: true });
    const remote = remoteHomeScript(dir, "printf %s 'hello world'");
    const { stdout } = await exec('sh', ['-c', remote]);
    expect(stdout).toBe('hello world');
    expect(() => remoteHomeScript('bad;touch', 'true')).toThrow(/unsafe remote path/);
    expect(quoteShellArg("a'b")).toBe(`'a'\\''b'`);
    await rm(abs, { recursive: true, force: true });
  });
});

describe('staging paths', () => {
  it('gives each workspace of one user and project its own folder', () => {
    expect(stagingRel('usr_a', 'demo', 'ws_1')).toBe('workspaces/usr_a/demo/ws_1');
    expect(stagingRel('usr_a', 'demo', 'ws_2')).not.toBe(stagingRel('usr_a', 'demo', 'ws_1'));
    expect(() => stagingRel('usr_a', 'demo', '../ws_1')).toThrow(/workspace id/);
  });
});

describe('fingerprint', () => {
  it('changes when the lockfile, node, arch, or Xcode version changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fp-'));
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lock-a\n');
    const runtime = { nodeVersion: 'v22.0.0', arch: 'arm64', platform: 'darwin', xcodeVersion: 'Xcode 16.0' };
    const first = buildFingerprint(await collectLockfiles(dir), runtime);
    const same = buildFingerprint(await collectLockfiles(dir), runtime);
    expect(needsDependencyRefresh(first, same)).toBe(false);
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lock-b\n');
    const nextLock = buildFingerprint(await collectLockfiles(dir), runtime);
    expect(needsDependencyRefresh(first, nextLock)).toBe(true);
    const nextNode = buildFingerprint(await collectLockfiles(dir), { ...runtime, nodeVersion: 'v20.0.0' });
    expect(fingerprintDigest(nextNode)).not.toBe(fingerprintDigest(nextLock));
    const nextXcode = buildFingerprint(await collectLockfiles(dir), { ...runtime, xcodeVersion: 'Xcode 16.1' });
    expect(needsDependencyRefresh(nextLock, nextXcode)).toBe(true);
    const nextArch = buildFingerprint(await collectLockfiles(dir), { ...runtime, arch: 'x64' });
    expect(needsDependencyRefresh(nextLock, nextArch)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('dependencies', () => {
  it('runs pnpm install only when the snapshot has package.json and pnpm-lock.yaml', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'deps-'));
    const snapshotDir = path.join(dir, 'snap');
    await mkdir(snapshotDir);
    const fingerprint = buildFingerprint(await collectLockfiles(snapshotDir), {
      nodeVersion: 'v22.0.0',
      arch: 'arm64',
      platform: 'linux',
      xcodeVersion: null,
    });
    const installs: string[] = [];
    const run = () =>
      ensureDependencies({
        snapshotDir,
        cacheDir: path.join(dir, 'cache'),
        workspaceKey: 'ws_1',
        fingerprint,
        install: async (cwd) => {
          installs.push(cwd);
          return 0;
        },
      });
    await writeFile(path.join(snapshotDir, 'build.gradle'), '\n');
    expect((await run()).skipped).toBe(true);
    await writeFile(path.join(snapshotDir, 'package.json'), '{}\n');
    expect((await run()).skipped).toBe(true);
    expect(installs).toEqual([]);
    await writeFile(path.join(snapshotDir, 'pnpm-lock.yaml'), 'lock\n');
    expect((await run()).skipped).toBe(false);
    expect(installs).toEqual([snapshotDir]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('config', () => {
  it('parses profiles and defaults', () => {
    const config = parseTestboxConfig(`
project: demo
profiles:
  unit:
    cmd: pnpm test
  ios:
    cmd: xcodebuild test
    artifacts:
      - "**/*.xcresult"
    requires:
      - ios-simulator
`);
    expect(config.project).toBe('demo');
    expect(config.ignore).toContain('node_modules');
    expect(config.profiles.ios.requires).toEqual(['ios-simulator']);
    const aliased = parseTestboxConfig(`
project: demo
profiles:
  unit:
    command: pnpm test
  ios:
    command: xcodebuild test
    requires: [macos, xcode]
`);
    expect(aliased.profiles.unit.cmd).toBe('pnpm test');
    expect(aliased.profiles.unit.requires).toEqual([]);
    expect(aliased.profiles.ios.requires).toEqual(['macos', 'xcode']);
  });

  it('parses links as safe names, default none, and rejects a bad, repeated, or project name', () => {
    const config = parseTestboxConfig('project: interface\nprofiles:\n  unit:\n    cmd: make\n  ios:\n    cmd: xcodebuild\n    links: [api, shared.kit]\n');
    expect(config.profiles.unit.links).toEqual([]);
    expect(config.profiles.ios.links).toEqual(['api', 'shared.kit']);
    const bad = (links: string) => () => parseTestboxConfig(`project: interface\nprofiles:\n  ios:\n    cmd: x\n    links: ${links}\n`);
    expect(bad('[../api]')).toThrow(ConfigError);
    expect(bad('[../api]')).toThrow('a link name must match');
    expect(bad('[api, api]')).toThrow('a link name is listed twice');
    expect(bad('[api, API]')).toThrow('a link name is listed twice');
    expect(bad('[Interface]')).toThrow('a link cannot have the project name interface');
    expect(bad('[interface]')).toThrow('a link cannot have the project name interface');
    const many = `[${Array.from({ length: 21 }, (_, i) => `l${i}`).join(', ')}]`;
    expect(bad(many)).toThrow('a profile can have at most 20 links');
  });

  it('parses worker capacity, ssh host, and extra labels', () => {
    const config = parseWorkerConfig(`
capacity: 2
sshHost: testbox@builder-1
labels:
  - gpu
`);
    expect(config.capacity).toBe(2);
    expect(config.sshHost).toBe('testbox@builder-1');
    expect(config.labels).toEqual(['gpu']);
  });
});

describe('glob and redaction', () => {
  it('matches artifact globs and redacts secrets', () => {
    expect(matchGlob('coverage/a/b.txt', 'coverage/**')).toBe(true);
    expect(matchGlob('Build/Logs/Test.xcresult', '**/*.xcresult')).toBe(true);
    expect(matchGlob('src/index.ts', 'coverage/**')).toBe(false);
    const text = 'Authorization: Bearer abcdefghijklmnop token=supersecretvalue';
    const redacted = redact(text, ['supersecretvalue']);
    expect(redacted).not.toContain('supersecretvalue');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).toContain('[REDACTED]');
  });
});

describe('job source', () => {
  it.each([
    [{ path: '/Users/ana/code/app', branch: 'TGN-811', commit: '3edf65d', dirty: true }, 'source: /Users/ana/code/app TGN-811@3edf65d (dirty)'],
    [{ path: '/Users/ana/code/app', branch: 'main', commit: '3edf65d', dirty: false }, 'source: /Users/ana/code/app main@3edf65d'],
    [{ path: '/Users/ana/code/app', commit: '3edf65d' }, 'source: /Users/ana/code/app 3edf65d'],
    [{ path: '/Users/ana/code/app' }, 'source: /Users/ana/code/app'],
    [{ path: '/Users/ana/code/app\nfake: line', branch: 'main\x1b[31m' }, 'source: /Users/ana/code/app fake: line main [31m'],
    [
      {
        path: '/code/interface_TGN-821',
        branch: 'TGN-821',
        commit: '3edf65d',
        links: [
          { name: 'api', path: '/code/api_TGN-821', branch: 'TGN-821', commit: '91ab2c0', dirty: true },
          { name: 'kit', path: '/code/kit' },
        ],
      },
      'source: /code/interface_TGN-821 TGN-821@3edf65d +api:TGN-821@91ab2c0(dirty) +kit',
    ],
  ])('formats %j as one log line', (source, line) => {
    expect(formatJobSource(source)).toBe(line);
  });
});

describe('job state transitions', () => {
  const allowed: Record<JobState, JobState[]> = {
    queued: ['assigned', 'cancelled'],
    assigned: ['running', 'cancelled', 'timed_out'],
    running: ['succeeded', 'failed', 'cancelled', 'timed_out'],
    succeeded: [],
    failed: [],
    cancelled: [],
    timed_out: [],
  };
  const pairs = JOB_STATES.flatMap((from) => JOB_STATES.map((to) => [from, to, allowed[from].includes(to)] as const));

  it.each(pairs)('%s -> %s is allowed: %s', (from, to, ok) => {
    expect(canTransition(from, to)).toBe(ok);
    if (ok) expect(() => assertTransition(from, to)).not.toThrow();
    else expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
  });

  it('marks only finished states as terminal', () => {
    expect(JOB_STATES.filter((state) => isTerminal(state))).toEqual(['succeeded', 'failed', 'cancelled', 'timed_out']);
  });
});

describe('exit codes', () => {
  it.each([
    ['queued', 1],
    ['assigned', 1],
    ['running', 1],
    ['succeeded', 0],
    ['failed', 1],
    ['cancelled', 13],
    ['timed_out', 12],
  ] as const)('a job that ends %s exits %i', (state, code) => {
    expect(exitCodeForJob(state)).toBe(code);
  });

  it.each([
    ['', 401, 20],
    ['', 403, 20],
    ['', 404, 1],
    ['', 500, 1],
    ['', 503, 11],
    ['', undefined, 1],
    ['AUTH', 400, 20],
    ['NO_WORKER', 400, 11],
    ['SYNC', 400, 10],
    ['TIMEOUT', 400, 12],
    ['CANCELLED', 400, 13],
    ['BAD_REQUEST', 400, 1],
  ] as const)('an API error with code %j and status %j exits %i', (code, status, exit) => {
    expect(exitCodeForApiError(code, status)).toBe(exit);
  });

  it.each([
    [ExitCode.JobFailed, 'read the log'],
    [ExitCode.Usage, 'testbox.yml'],
    [ExitCode.SyncError, 'testbox doctor'],
    [ExitCode.NoWorker, 'requires'],
    [ExitCode.Timeout, '--timeout'],
    [ExitCode.Cancelled, 'cancelled'],
    [ExitCode.Auth, 'setup line'],
  ])('exit %i has a hint that says what to do', (code, words) => {
    expect(hintForExitCode(code)).toContain(words);
  });

  it('has no hint for a pass or an unknown code, and a different hint for each failure', () => {
    expect(hintForExitCode(ExitCode.Pass)).toBeUndefined();
    expect(hintForExitCode(99)).toBeUndefined();
    const failures = Object.values(ExitCode).filter((code) => code !== ExitCode.Pass);
    expect(new Set(failures.map((code) => hintForExitCode(code))).size).toBe(failures.length);
  });
});

describe('quoting and path safety', () => {
  it('quotes the cwd of a remote command', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tb cwd-'));
    const marker = path.join(dir, 'MARKER');
    try {
      await exec('sh', ['-c', remoteBash('true', `x; touch ${quoteShellArg(marker)}`)]).catch(() => undefined);
      await expect(readFile(marker, 'utf8')).rejects.toThrow();
      const { stdout } = await exec('sh', ['-c', remoteBash('pwd -P', dir)]);
      expect(stdout.trim()).toBe(await realpath(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['$(id)', '`id`', 'a"b', 'a b', "a'b", 'a\\b'])('rejects the home path segment %j', (segment) => {
    expect(() => remoteHomeScript(`work/${segment}`, 'true')).toThrow(/unsafe remote path segment/);
  });

  it.each(['..', '.', '.hidden', '-flag', '', 'a/b', 'a'.repeat(82)])('rejects %j as one path segment', (segment) => {
    expect(() => assertSafeSegment(segment)).toThrow();
    expect(() => stagingRel('usr_a', 'demo', segment)).toThrow(/workspace id/);
    expect(() => stagingRel('usr_a', segment, 'ws_1')).toThrow(/project/);
    expect(() => snapshotRel(segment)).toThrow(/snapshot id/);
  });

  it('accepts a segment of up to 81 characters', () => {
    expect(snapshotRel(`s${'a'.repeat(80)}`)).toBe(`snapshots/s${'a'.repeat(80)}`);
  });

  it.each(['a\nb', 'a\rb', 'a\0b'])('does not quote %j', (value) => {
    expect(() => quoteShellArg(value)).toThrow(/newline or NUL/);
  });

  it.each(['a b', 'a;b', 'a\nb', 'a$(id)', ''])('rejects the ssh host %j', (host) => {
    expect(() => buildSshArgs(host, 'true')).toThrow(/unsafe ssh host/);
  });

  it('builds the exact ssh argv, with and without a key', () => {
    expect(buildSshArgs('testbox@builder-1', 'echo hi')).toEqual([
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', 'testbox@builder-1', '--', 'echo hi',
    ]);
    expect(buildSshArgs('testbox@builder-1', 'echo hi', '/k/id_ed25519')).toEqual([
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-i', '/k/id_ed25519', '-o', 'IdentitiesOnly=yes',
      'testbox@builder-1', '--', 'echo hi',
    ]);
    expect(() => buildSshArgs('h', 'true', 'a\nb')).toThrow(/unsafe identity file/);
  });
});

describe('config rules', () => {
  it('ignores the full default list when testbox.yml has no ignore', () => {
    expect(DEFAULT_IGNORE).toEqual([
      'node_modules', '.next', '.git', '.env', '.env.*', 'dist', 'build', 'coverage', 'DerivedData', '.turbo', '.testbox',
    ]);
    expect(parseTestboxConfig('project: demo\n').ignore).toEqual(DEFAULT_IGNORE);
  });

  it('rejects an empty cmd and prefers cmd over command', () => {
    expect(() => parseTestboxConfig('project: demo\nprofiles:\n  unit:\n    cmd: ""\n')).toThrow(ConfigError);
    const both = parseTestboxConfig('project: demo\nprofiles:\n  unit:\n    cmd: a\n    command: b\n');
    expect(both.profiles.unit.cmd).toBe('a');
  });

  it('reports an unreadable testbox.yml instead of looking further up', async () => {
    if (process.getuid?.() === 0) return; // root can read a file with mode 000
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cfg-'));
    const file = path.join(dir, 'testbox.yml');
    try {
      await writeFile(file, 'project: demo\n');
      await chmod(file, 0o000);
      await expect(loadRepoConfig(dir)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(file, 0o600);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('limits worker capacity to 1 through 64', () => {
    expect(parseWorkerConfig('capacity: 1\n').capacity).toBe(1);
    expect(parseWorkerConfig('capacity: 64\n').capacity).toBe(64);
    expect(() => parseWorkerConfig('capacity: 0\n')).toThrow(/invalid worker config/);
    expect(() => parseWorkerConfig('capacity: 65\n')).toThrow(/invalid worker config/);
  });
});

describe('redaction length', () => {
  it('hides a secret of 6 characters and keeps a shorter value', () => {
    expect(redact('x abc123 y', ['abc123'])).toBe('x [REDACTED] y');
    expect(redact('x abc12 y', ['abc12'])).toBe('x abc12 y');
  });
});

describe('lockfiles and installs', () => {
  it('finds a lockfile three folders deep', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fp-'));
    try {
      await mkdir(path.join(dir, 'a', 'b', 'c'), { recursive: true });
      await writeFile(path.join(dir, 'a', 'b', 'c', 'pnpm-lock.yaml'), 'lock\n');
      expect(Object.keys(await collectLockfiles(dir))).toEqual(['a/b/c/pnpm-lock.yaml']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([1, -1, 130])('fails when the install exits %i', async (code) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'deps-'));
    try {
      const snapshotDir = path.join(dir, 'snap');
      await mkdir(snapshotDir);
      await writeFile(path.join(snapshotDir, 'package.json'), '{}\n');
      await writeFile(path.join(snapshotDir, 'pnpm-lock.yaml'), 'lock\n');
      const fingerprint = buildFingerprint({}, { nodeVersion: null, arch: 'x64', platform: 'linux', xcodeVersion: null });
      await expect(
        ensureDependencies({ snapshotDir, cacheDir: path.join(dir, 'cache'), workspaceKey: 'ws', fingerprint, install: async () => code }),
      ).rejects.toThrow(`dependency install failed with exit ${code}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
