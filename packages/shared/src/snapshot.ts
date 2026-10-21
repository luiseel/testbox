import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import { mkdir, open, readdir, readFile, rm } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { assertSafeSegment, resolveInside } from './paths';
import { writeRetention } from './retention';

const execFileAsync = promisify(execFile);

export async function withExclusiveLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { waitSeconds?: number } = {},
): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const created = await open(lockPath, 'a');
  await created.close();
  // node writes "ready" and flushes before waiting on stdin. A shell printf would
  // stay block-buffered on a pipe and deadlock the waiter.
  const child = spawn(
    'flock',
    [
      '-x',
      ...(opts.waitSeconds !== undefined ? ['-w', String(opts.waitSeconds)] : []),
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
  // A missing flock binary: the spawn fails, and the stdout stream closes without "ready".
  child.once('error', (err) => {
    stderr += err.message;
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
  /** The folder of the main tree in the snapshot, and the job cwd. Only set when the snapshot has links. */
  workDir?: string;
}

/** Another staging tree that is copied next to the main tree, into `snapshots/<id>/<name>`. */
export interface SnapshotLink {
  name: string;
  stagingRel: string;
  ignore: readonly string[];
}

/**
 * Copy a staging tree into an immutable snapshot while holding the workspace lock.
 * Mutagen must already be paused by the caller so the staging tree is stable.
 *
 * Without links the tree is `snapshots/<id>`. With links the main tree is
 * `snapshots/<id>/<workDir>` and each link is `snapshots/<id>/<link name>`; the
 * lock of each staging tree is held, and the digest covers `snapshots/<id>`.
 */
export async function createSnapshot(opts: {
  dataDir: string;
  stagingRel: string;
  snapshotId: string;
  ignore: readonly string[];
  retentionMs: number;
  now?: number;
  links?: readonly SnapshotLink[];
  workDir?: string;
}): Promise<SnapshotResult> {
  assertSafeSegment(opts.snapshotId, 'snapshot id');
  const links = opts.links ?? [];
  const relPath = path.posix.join('snapshots', opts.snapshotId);
  const dest = resolveInside(opts.dataDir, relPath);
  const trees: { stagingRel: string; ignore: readonly string[]; folder: string | null }[] = [
    { stagingRel: opts.stagingRel, ignore: opts.ignore, folder: null },
  ];
  if (links.length > 0) {
    if (!opts.workDir) throw new Error('a snapshot with links needs a work dir');
    assertSafeSegment(opts.workDir, 'work dir');
    trees[0].folder = opts.workDir;
    // Case does not count: this disk can be case-insensitive, so App and app would be one folder.
    const names = new Set([opts.workDir.toLowerCase()]);
    for (const link of links) {
      assertSafeSegment(link.name, 'link name');
      if (names.has(link.name.toLowerCase())) throw new Error(`link name ${link.name} is used twice`);
      names.add(link.name.toLowerCase());
      trees.push({ stagingRel: link.stagingRel, ignore: link.ignore, folder: link.name });
    }
  }
  const sources = trees.map((tree) => ({ ...tree, staging: resolveInside(opts.dataDir, tree.stagingRel) }));
  // Take the locks in one order, so two snapshots that share a tree never wait on each other.
  const lockPaths = [...new Set(trees.map((tree) => snapshotLockPath(opts.dataDir, tree.stagingRel)))].sort();
  const copy = async () => {
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    for (const tree of sources) {
      const target = tree.folder ? path.join(dest, tree.folder) : dest;
      await mkdir(target, { recursive: true });
      const args = ['-a'];
      for (const pattern of tree.ignore) {
        if (pattern.includes('\n') || pattern.includes('\0')) {
          throw new Error('illegal ignore pattern');
        }
        args.push(`--exclude=${pattern}`);
      }
      args.push(`${tree.staging}/`, `${target}/`);
      await execFileAsync('rsync', args);
    }
  };
  const locked = lockPaths.reduceRight<() => Promise<void>>((inner, lockPath) => () => withExclusiveLock(lockPath, inner), copy);
  await locked();
  const digest = await directoryDigest(dest);
  const until = (opts.now ?? Date.now()) + opts.retentionMs;
  await writeRetention(opts.dataDir, 'snapshots', opts.snapshotId, until);
  return links.length > 0 ? { digest, relPath, workDir: opts.workDir } : { digest, relPath };
}

/** The lock file a snapshot holds while it copies the staging tree `stagingRel`. */
export function snapshotLockPath(dataDir: string, stagingRel: string): string {
  return path.join(dataDir, 'locks', lockName(stagingRel));
}

function lockName(stagingRel: string): string {
  return `${stagingRel.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)}.lock`;
}
