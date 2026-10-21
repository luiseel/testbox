import { mkdir, mkdtemp, rm, symlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { canonicalDirs, withSnapshotLocks } from '../src/lock';

/** Two runs on one machine that share a checkout must not flush, pause, and resume its sync under each other. */
describe('snapshot locks', () => {
  it('serializes two runs that share a checkout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tb-lock-'));
    const main = path.join(root, 'interface');
    const other = path.join(root, 'interface_TGN-1');
    const api = path.join(root, 'api');
    for (const dir of [main, other, api]) await mkdir(dir);
    const order: string[] = [];
    try {
      let release!: () => void;
      const first = withSnapshotLocks([main, api], async () => {
        order.push('first start');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        order.push('first end');
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = withSnapshotLocks([api, other], async () => {
        order.push('second start');
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(order).toEqual(['first start']);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(['first start', 'first end', 'second start']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('locks one physical checkout once, gives up after the wait, and names a missing flock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tb-lock-'));
    const api = path.join(root, 'api');
    const alias = path.join(root, 'api-alias');
    const envPath = process.env.PATH;
    try {
      await mkdir(api);
      await symlink(api, alias);
      expect(await canonicalDirs([api, alias])).toEqual(await canonicalDirs([api]));
      // The same checkout under two names: one lock, so no wait on itself.
      expect(await withSnapshotLocks([api, alias], async () => 'ran')).toBe('ran');

      let release!: () => void;
      const holder = withSnapshotLocks([api], () => new Promise<void>((resolve) => (release = resolve)));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(withSnapshotLocks([alias], async () => 'never', { waitSeconds: 1 })).rejects.toThrow('another testbox run holds');
      release();
      await holder;

      process.env.PATH = root;
      await expect(withSnapshotLocks([api], async () => 'never')).rejects.toThrow('flock is missing');
    } finally {
      process.env.PATH = envPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
