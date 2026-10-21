import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildFingerprint,
  cleanupExpired,
  createSnapshot,
  directoryDigest,
  ensureDependencies,
  snapshotLockPath,
  withExclusiveLock,
  writeRetention,
} from '../src';

describe('snapshots', () => {
  it('freezes staging contents and ignores secrets', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'snap-'));
    const stagingRel = 'workspaces/usr_a/demo/ws_1';
    const staging = path.join(dataDir, stagingRel);
    await mkdir(path.join(staging, 'node_modules'), { recursive: true });
    await writeFile(path.join(staging, 'hello.txt'), 'v1\n');
    await writeFile(path.join(staging, '.env'), 'SECRET=1\n');
    await writeFile(path.join(staging, 'node_modules', 'left.txt'), 'nope\n');
    const snap = await createSnapshot({
      dataDir,
      stagingRel,
      snapshotId: 'snap_aaaaaaaaaaaaaaaaaaaaaaaa',
      ignore: ['node_modules', '.git', '.env'],
      retentionMs: 1000,
    });
    await writeFile(path.join(staging, 'hello.txt'), 'v2\n');
    const frozen = await readFile(path.join(dataDir, snap.relPath, 'hello.txt'), 'utf8');
    expect(frozen).toBe('v1\n');
    await expect(readFile(path.join(dataDir, snap.relPath, '.env'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(dataDir, snap.relPath, 'node_modules', 'left.txt'), 'utf8')).rejects.toThrow();
    expect(snap.digest).toBe(await directoryDigest(path.join(dataDir, snap.relPath)));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('puts the main tree and each link in sibling folders, with their own excludes and one digest', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'snap-'));
    const mainRel = 'workspaces/usr_a/interface/ws_1';
    const apiRel = 'workspaces/usr_a/api/ws_2';
    await mkdir(path.join(dataDir, mainRel, 'ios'), { recursive: true });
    await writeFile(path.join(dataDir, mainRel, 'ios', 'App.swift'), 'app\n');
    await writeFile(path.join(dataDir, mainRel, 'skip-main.txt'), 'x\n');
    await mkdir(path.join(dataDir, apiRel, 'client'), { recursive: true });
    await writeFile(path.join(dataDir, apiRel, 'client', 'Package.swift'), 'pkg\n');
    await writeFile(path.join(dataDir, apiRel, 'skip-api.txt'), 'x\n');
    await writeFile(path.join(dataDir, apiRel, 'skip-main.txt'), 'kept\n');
    try {
      const snap = await createSnapshot({
        dataDir,
        stagingRel: mainRel,
        snapshotId: 'snap_bbbbbbbbbbbbbbbbbbbbbbbb',
        ignore: ['skip-main.txt'],
        retentionMs: 1000,
        workDir: 'interface',
        links: [{ name: 'api', stagingRel: apiRel, ignore: ['skip-api.txt'] }],
      });
      expect(snap).toMatchObject({ relPath: 'snapshots/snap_bbbbbbbbbbbbbbbbbbbbbbbb', workDir: 'interface' });
      const root = path.join(dataDir, snap.relPath);
      expect((await readdir(root)).sort()).toEqual(['api', 'interface']);
      // The job runs in <root>/interface, so ../api is the linked checkout.
      expect(await readFile(path.join(root, 'interface', '..', 'api', 'client', 'Package.swift'), 'utf8')).toBe('pkg\n');
      expect(await readFile(path.join(root, 'interface', 'ios', 'App.swift'), 'utf8')).toBe('app\n');
      await expect(readFile(path.join(root, 'interface', 'skip-main.txt'))).rejects.toThrow();
      await expect(readFile(path.join(root, 'api', 'skip-api.txt'))).rejects.toThrow();
      expect(await readFile(path.join(root, 'api', 'skip-main.txt'), 'utf8')).toBe('kept\n');
      expect(snap.digest).toBe(await directoryDigest(root));
      expect(snap.digest).not.toBe(await directoryDigest(path.join(root, 'interface')));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the old layout without links, and waits for the lock of a linked tree', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'snap-'));
    const mainRel = 'workspaces/usr_a/interface/ws_1';
    const apiRel = 'workspaces/usr_a/api/ws_2';
    await mkdir(path.join(dataDir, mainRel), { recursive: true });
    await mkdir(path.join(dataDir, apiRel), { recursive: true });
    await writeFile(path.join(dataDir, mainRel, 'a.txt'), 'a\n');
    try {
      const plain = await createSnapshot({ dataDir, stagingRel: mainRel, snapshotId: 'snap_cccccccccccccccccccccccc', ignore: [], retentionMs: 1000 });
      expect(plain.workDir).toBeUndefined();
      expect(await readFile(path.join(dataDir, plain.relPath, 'a.txt'), 'utf8')).toBe('a\n');

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = new Promise<void>((resolve) => {
        void withExclusiveLock(snapshotLockPath(dataDir, apiRel), async () => {
          resolve();
          await gate;
        });
      });
      await held;
      let done = false;
      const linked = createSnapshot({
        dataDir,
        stagingRel: mainRel,
        snapshotId: 'snap_dddddddddddddddddddddddd',
        ignore: [],
        retentionMs: 1000,
        workDir: 'interface',
        links: [{ name: 'api', stagingRel: apiRel, ignore: [] }],
      }).then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(done).toBe(false);
      release();
      await linked;
      expect(done).toBe(true);
      await expect(createSnapshot({
        dataDir,
        stagingRel: mainRel,
        snapshotId: 'snap_eeeeeeeeeeeeeeeeeeeeeeee',
        ignore: [],
        retentionMs: 1000,
        links: [{ name: 'api', stagingRel: apiRel, ignore: [] }],
      })).rejects.toThrow('needs a work dir');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('serializes snapshot creators with the workspace lock', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lock-'));
    const lock = path.join(dir, 'workspace.lock');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let marked = false;
    const held = new Promise<void>((resolve) => {
      void withExclusiveLock(lock, async () => {
        marked = true;
        resolve();
        await gate;
      });
    });
    await held;
    let second = false;
    const other = withExclusiveLock(lock, async () => {
      second = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(second).toBe(false);
    release();
    await other;
    expect(second).toBe(true);
    expect(marked).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('retention', () => {
  it('removes expired snapshots and artifacts and keeps the cache', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ret-'));
    await mkdir(path.join(dataDir, 'cache', 'modules'), { recursive: true });
    await writeFile(path.join(dataDir, 'cache', 'modules', 'keep.txt'), 'warm\n');
    await mkdir(path.join(dataDir, 'artifacts', 'job_a'), { recursive: true });
    await writeFile(path.join(dataDir, 'artifacts', 'job_a', 'out.txt'), 'x\n');
    await mkdir(path.join(dataDir, 'workspaces', 'u'), { recursive: true });
    await writeFile(path.join(dataDir, 'workspaces', 'u', 'src.txt'), 'live\n');
    await writeRetention(dataDir, 'artifacts', 'job_a', Date.now() - 1000);
    const result = await cleanupExpired(dataDir, Date.now());
    expect(result.removed).toContain(path.join('artifacts', 'job_a'));
    expect(await readFile(path.join(dataDir, 'cache', 'modules', 'keep.txt'), 'utf8')).toBe('warm\n');
    expect(await readFile(path.join(dataDir, 'workspaces', 'u', 'src.txt'), 'utf8')).toBe('live\n');
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe('dependency cache', () => {
  it('reinstalls only when the fingerprint changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deps-'));
    const snapshotA = path.join(root, 'a');
    const snapshotB = path.join(root, 'b');
    const cache = path.join(root, 'cache');
    await mkdir(snapshotA, { recursive: true });
    await mkdir(snapshotB, { recursive: true });
    await writeFile(path.join(snapshotA, 'package.json'), '{"name":"demo"}\n');
    await writeFile(path.join(snapshotB, 'package.json'), '{"name":"demo"}\n');
    for (const dir of [snapshotA, snapshotB]) await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lock\n');
    const fp = buildFp('lock-a');
    let installs = 0;
    const install = async (cwd: string) => {
      installs += 1;
      await mkdir(path.join(cwd, 'node_modules'), { recursive: true });
      await writeFile(path.join(cwd, 'node_modules', 'marker.txt'), `install-${installs}\n`);
      return 0;
    };
    const first = await ensureDependencies({
      snapshotDir: snapshotA,
      cacheDir: cache,
      workspaceKey: 'ws',
      fingerprint: fp,
      install,
    });
    expect(first.refreshed).toBe(true);
    const second = await ensureDependencies({
      snapshotDir: snapshotB,
      cacheDir: cache,
      workspaceKey: 'ws',
      fingerprint: fp,
      install,
    });
    expect(second.refreshed).toBe(false);
    expect(installs).toBe(1);
    expect(await readFile(path.join(snapshotB, 'node_modules', 'marker.txt'), 'utf8')).toBe('install-1\n');
    const changed = await ensureDependencies({
      snapshotDir: snapshotA,
      cacheDir: cache,
      workspaceKey: 'ws',
      fingerprint: buildFp('lock-b'),
      install,
    });
    expect(changed.refreshed).toBe(true);
    expect(installs).toBe(2);
    expect(await readFile(path.join(cache, 'modules', first.digest, 'marker.txt'), 'utf8')).toContain('install-1');
    await rm(root, { recursive: true, force: true });
  });
});

function buildFp(lock: string) {
  return buildFingerprint({ 'pnpm-lock.yaml': lock }, {
    nodeVersion: 'v22.0.0',
    arch: 'arm64',
    platform: 'darwin',
    xcodeVersion: 'Xcode 16.0',
  });
}
