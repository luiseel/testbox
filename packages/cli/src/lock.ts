import { mkdir, open, readFile, rm } from 'fs/promises';
import path from 'path';
import { SyncError } from './remote';

const RETRY_MS = 200;

/** The lock file of a checkout: held while its sync is paused for a snapshot. */
export function snapshotLockFile(dir: string): string {
  return path.join(dir, '.testbox', 'snapshot.lock');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquire(file: string, waitMs: number, now: () => number): Promise<void> {
  const deadline = now() + waitMs;
  await mkdir(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // A lock of a process that is gone (a killed CLI) is stale: take it over.
    let holder = NaN;
    try {
      holder = Number((await readFile(file, 'utf8')).trim());
    } catch {
      // removed between the open and the read: try again
    }
    if (Number.isFinite(holder) && holder > 0 && !alive(holder)) {
      await rm(file, { force: true });
      continue;
    }
    if (now() >= deadline) {
      throw new SyncError(`another testbox run holds ${file}; wait for it, or delete the file if no testbox runs`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/**
 * Hold the snapshot lock of each checkout while `fn` runs, so two runs on this machine that share a
 * checkout (a link of both) do not pause and resume its sync under each other's snapshot. The locks are
 * taken in path order, so two runs that share several checkouts cannot wait on each other forever.
 */
export async function withSnapshotLocks<T>(
  dirs: readonly string[],
  fn: () => Promise<T>,
  opts: { waitMs?: number; now?: () => number } = {},
): Promise<T> {
  const files = [...new Set(dirs.map((dir) => snapshotLockFile(dir)))].sort();
  const held: string[] = [];
  try {
    for (const file of files) {
      await acquire(file, opts.waitMs ?? 15 * 60 * 1000, opts.now ?? Date.now);
      held.push(file);
    }
    return await fn();
  } finally {
    for (const file of held.reverse()) await rm(file, { force: true });
  }
}
