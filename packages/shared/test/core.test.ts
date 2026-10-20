import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  assertTransition,
  buildFingerprint,
  buildShellSpawn,
  canTransition,
  collectLockfiles,
  ensureDependencies,
  fingerprintDigest,
  formatJobSource,
  isTerminal,
  matchGlob,
  needsDependencyRefresh,
  parseTestboxConfig,
  parseWorkerConfig,
  quoteShellArg,
  redact,
  remoteBash,
  remoteHomeScript,
  stagingRel,
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
  ])('formats %j as one log line', (source, line) => {
    expect(formatJobSource(source)).toBe(line);
  });
});
