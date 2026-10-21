import { realpath } from 'fs/promises';
import path from 'path';
import { withExclusiveLock } from '@testbox/shared';
import { SyncError } from './remote';

/** The lock file of a checkout: held while its sync is flushed, paused, and copied. */
export function snapshotLockFile(dir: string): string {
  return path.join(dir, '.testbox', 'snapshot.lock');
}

/** The canonical path of each checkout, without duplicates. */
export async function canonicalDirs(dirs: readonly string[]): Promise<string[]> {
  const real = await Promise.all(dirs.map((dir) => realpath(dir)));
  return [...new Set(real)];
}

/**
 * Hold the snapshot lock of each checkout while `fn` runs, so two runs on this machine that share a
 * checkout (a link of both) do not flush, pause, and resume its sync under each other's snapshot.
 * The lock is an OS lock (`flock`), so a killed CLI releases it. The locks are taken in path order,
 * so two runs that share several checkouts cannot wait on each other forever.
 */
export async function withSnapshotLocks<T>(
  dirs: readonly string[],
  fn: () => Promise<T>,
  opts: { waitSeconds?: number } = {},
): Promise<T> {
  const files = (await canonicalDirs(dirs)).map((dir) => snapshotLockFile(dir)).sort();
  const waitSeconds = opts.waitSeconds ?? 15 * 60;
  const hold = async (index: number): Promise<T> => {
    if (index === files.length) return fn();
    const file = files[index];
    try {
      return await withExclusiveLock(file, () => hold(index + 1), { waitSeconds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.startsWith('failed to acquire lock')) throw err;
      if (/ENOENT/.test(message)) {
        throw new SyncError('flock is missing; install it (macOS: brew install flock), then run again');
      }
      throw new SyncError(`another testbox run holds ${file}; wait for it, then run again`);
    }
  };
  return hold(0);
}
