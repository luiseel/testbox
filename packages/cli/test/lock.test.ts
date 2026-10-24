import { mkdir, mkdtemp, rm, symlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { canonicalDirs, withSnapshotLocks } from '../src/lock';

/** A lock holder that says when it is inside, and waits until it is released. */
function holder(dirs: string[]): { done: Promise<void>; inside: Promise<void>; release: () => void } {
  let inside!: () => void;
  let release!: () => void;
  const insidePromise = new Promise<void>((resolve) => (inside = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const done = withSnapshotLocks(dirs, async () => {
    inside();
    await released;
  });
  return { done, inside: insidePromise, release };
}

/** Two runs on one machine that share a checkout must not flush, pause, and resume its sync under each other. */
describe('snapshot locks', () => {
  it('serializes two runs that share a checkout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tb-lock-'));
    const main = path.join(root, 'interface');
    const other = path.join(root, 'interface_TGN-1');
    const api = path.join(root, 'api');
    for (const dir of [main, other, api]) await mkdir(dir);
    try {
      const first = holder([main, api]);
      await first.inside;
      let secondStarted = false;
      const second = withSnapshotLocks([api, other], async () => {
        secondStarted = true;
      });
      // The second run shares api: it must still wait after a bounded time.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(secondStarted).toBe(false);
      first.release();
      await Promise.all([first.done, second]);
      expect(secondStarted).toBe(true);
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

      const first = holder([api]);
      await first.inside;
      await expect(withSnapshotLocks([alias], async () => 'never', { waitSeconds: 1 })).rejects.toThrow(
        'another testbox run holds',
      );
      first.release();
      await first.done;

      process.env.PATH = root;
      await expect(withSnapshotLocks([api], async () => 'never')).rejects.toThrow('flock is missing');
    } finally {
      process.env.PATH = envPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
