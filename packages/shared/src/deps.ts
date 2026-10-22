import { execFile as execFileCb } from 'child_process';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import {
  fingerprintDigest,
  type DependencyFingerprint,
} from './fingerprint';

const execFile = promisify(execFileCb);

export interface EnsureDepsResult {
  refreshed: boolean;
  digest: string;
  skipped: boolean;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function linkTree(src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await execFile('cp', ['-al', src, dest]);
  } catch {
    const { cp } = await import('fs/promises');
    await cp(src, dest, { recursive: true });
  }
}

/**
 * Every `node_modules` folder under `root`, as paths relative to it. A pnpm
 * workspace has one in the root and one in each package, which holds the
 * links to the other packages. It does not look inside a `node_modules`.
 */
async function findModuleDirs(root: string, rel = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const child = path.join(rel, entry.name);
    if (entry.name === 'node_modules') found.push(child);
    else found.push(...(await findModuleDirs(root, child)));
  }
  return found;
}

/**
 * Reinstall when the lockfile, Node version, arch, or Xcode version changes.
 * A matching fingerprint hardlinks the warm `node_modules` folders (the root
 * and each workspace package) and does not touch the shared pnpm store
 * contents. Old fingerprint directories stay put.
 */
export async function ensureDependencies(opts: {
  snapshotDir: string;
  cacheDir: string;
  workspaceKey: string;
  fingerprint: DependencyFingerprint;
  install: (cwd: string, storeDir: string) => Promise<number>;
}): Promise<EnsureDepsResult> {
  const digest = fingerprintDigest(opts.fingerprint);
  // `pnpm install --frozen-lockfile` needs both files. A Gradle or Swift
  // project has neither, so it skips the install.
  const manifest = path.join(opts.snapshotDir, 'package.json');
  const lockfile = path.join(opts.snapshotDir, 'pnpm-lock.yaml');
  if (!(await exists(manifest)) || !(await exists(lockfile))) {
    return { refreshed: false, digest, skipped: true };
  }
  const stampPath = path.join(opts.cacheDir, 'stamps', `${opts.workspaceKey}.json`);
  // Each fingerprint keeps a tree with the snapshot's `node_modules` folders at
  // their own paths. `cache/modules` has only the root folder, so it is not used.
  const warmTree = path.join(opts.cacheDir, 'module-trees', digest);
  const storeDir = path.join(opts.cacheDir, 'pnpm-store');
  await mkdir(storeDir, { recursive: true });

  let previous: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(stampPath, 'utf8')) as { digest?: string };
    previous = parsed.digest ?? null;
  } catch {
    previous = null;
  }

  // Drop any synced or hardlinked folders first: a warm link must not mix with
  // them, and a refresh must not overwrite the previous fingerprint's cache.
  for (const rel of await findModuleDirs(opts.snapshotDir)) {
    await rm(path.join(opts.snapshotDir, rel), { recursive: true, force: true });
  }

  const warm = previous === digest && (await exists(path.join(warmTree, 'node_modules')));
  if (warm) {
    for (const rel of await findModuleDirs(warmTree)) {
      await linkTree(path.join(warmTree, rel), path.join(opts.snapshotDir, rel));
    }
    return { refreshed: false, digest, skipped: false };
  }

  const code = await opts.install(opts.snapshotDir, storeDir);
  if (code !== 0) {
    throw new Error(`dependency install failed with exit ${code}`);
  }
  const installed = await findModuleDirs(opts.snapshotDir);
  if (installed.includes('node_modules')) {
    await rm(warmTree, { recursive: true, force: true });
    for (const rel of installed) {
      await linkTree(path.join(opts.snapshotDir, rel), path.join(warmTree, rel));
    }
  }
  await mkdir(path.dirname(stampPath), { recursive: true });
  await writeFile(stampPath, JSON.stringify({ digest, at: Date.now() }));
  return { refreshed: true, digest, skipped: false };
}

export function derivedDataDir(cacheDir: string, digest: string): string {
  return path.join(cacheDir, 'derived-data', digest);
}
