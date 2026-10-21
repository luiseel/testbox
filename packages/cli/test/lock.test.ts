import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { snapshotLockFile, withSnapshotLocks } from '../src/lock';

/** Two runs on one machine that share a checkout must not pause and resume its sync under each other. */
describe('snapshot locks', () => {
  it('serializes two runs that share a checkout, and removes the lock files at the end', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tb-lock-'));
    const main = path.join(root, 'interface');
    const other = path.join(root, 'interface_TGN-1');
    const api = path.join(root, 'api');
    const order: string[] = [];
    try {
      let release!: () => void;
      const first = withSnapshotLocks([main, api], async () => {
        order.push('first start');
        expect(await readFile(snapshotLockFile(api), 'utf8')).toBe(`${process.pid}\n`);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        order.push('first end');
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = withSnapshotLocks([api, other], async () => {
        order.push('second start');
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(order).toEqual(['first start']);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(['first start', 'first end', 'second start']);
      for (const dir of [main, other, api]) await expect(stat(snapshotLockFile(dir))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('takes over the lock of a process that is gone, and gives up on a live one after the wait', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tb-lock-'));
    const dir = path.join(root, 'api');
    try {
      const file = snapshotLockFile(dir);
      await rm(file, { force: true });
      await withSnapshotLocks([dir], async () => undefined); // makes .testbox
      await writeFile(file, '999999999\n');
      expect(await withSnapshotLocks([dir], async () => 'ran')).toBe('ran');

      await writeFile(file, `${process.pid}\n`);
      let now = 0;
      await expect(withSnapshotLocks([dir], async () => 'never', { waitMs: 100, now: () => (now += 60) })).rejects.toThrow(
        'another testbox run holds',
      );
      expect(await readFile(file, 'utf8')).toBe(`${process.pid}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
