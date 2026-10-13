import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import { mkdir, open, readdir, readFile, rm } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { assertSafeSegment, resolveInside } from './paths';
import { writeRetention } from './retention';

const execFileAsync = promisify(execFile);

export async function withExclusiveLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const created = await open(lockPath, 'a');
  await created.close();
  // node writes "ready" and flushes before waiting on stdin. A shell printf would
  // stay block-buffered on a pipe and deadlock the waiter.
  const child = spawn(
    'flock',
    [
      '-x',
      lockPath,
      'node',
      '-e',
      'process.stdout.write("ready\\n",()=>process.stdin.resume());process.stdin.on("end",()=>process.exit(0));',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = await readUntil(child.stdout, 'ready\n');
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`failed to acquire lock ${lockPath}: ${stderr}`);
  }
  try {
    return await fn();
  } finally {
    child.stdin.end();
    await once(child, 'exit');
  }
}

function readUntil(stream: NodeJS.ReadableStream, marker: string): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      if (buf.includes(marker)) {
        cleanup();
        resolve(true);
      }
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('close', onClose);
      stream.off('end', onClose);
    };
    stream.on('data', onData);
    stream.on('close', onClose);
    stream.on('end', onClose);
  });
}

export async function directoryDigest(root: string): Promise<string> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) files.push(abs);
    }
  }
  try {
    await walk(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return createHash('sha256').digest('hex');
    }
    throw err;
  }
  const hash = createHash('sha256');
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    hash.update(rel);
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface SnapshotResult {
  digest: string;
  relPath: string;
}

/**
 * Copy a staging tree into an immutable snapshot while holding the workspace lock.
 * Mutagen must already be paused by the caller so the staging tree is stable.
 */
export async function createSnapshot(opts: {
  dataDir: string;
  stagingRel: string;
  snapshotId: string;
  ignore: readonly string[];
  retentionMs: number;
  now?: number;
}): Promise<SnapshotResult> {
  assertSafeSegment(opts.snapshotId, 'snapshot id');
  const staging = resolveInside(opts.dataDir, opts.stagingRel);
  const relPath = path.posix.join('snapshots', opts.snapshotId);
  const dest = resolveInside(opts.dataDir, relPath);
  const lockPath = path.join(opts.dataDir, 'locks', lockName(opts.stagingRel));
  await withExclusiveLock(lockPath, async () => {
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    const args = ['-a'];
    for (const pattern of opts.ignore) {
      if (pattern.includes('\n') || pattern.includes('\0')) {
        throw new Error('illegal ignore pattern');
      }
      args.push(`--exclude=${pattern}`);
    }
    args.push(`${staging}/`, `${dest}/`);
    await execFileAsync('rsync', args);
  });
  const digest = await directoryDigest(dest);
  const until = (opts.now ?? Date.now()) + opts.retentionMs;
  await writeRetention(opts.dataDir, 'snapshots', opts.snapshotId, until);
  return { digest, relPath };
}

function lockName(stagingRel: string): string {
  return `${stagingRel.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)}.lock`;
}
