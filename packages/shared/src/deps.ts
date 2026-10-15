import { execFile as execFileCb } from 'child_process';
import { access, mkdir, readFile, rm, writeFile } from 'fs/promises';
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
 * Reinstall when the lockfile, Node version, arch, or Xcode version changes.
 * A matching fingerprint hardlinks the warm `node_modules` tree and does not
 * touch the shared pnpm store contents. Old fingerprint directories stay put.
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
  const warmModules = path.join(opts.cacheDir, 'modules', digest);
  const storeDir = path.join(opts.cacheDir, 'pnpm-store');
  await mkdir(storeDir, { recursive: true });

  let previous: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(stampPath, 'utf8')) as { digest?: string };
    previous = parsed.digest ?? null;
  } catch {
    previous = null;
  }

  const warm = previous === digest && (await exists(warmModules));
  const snapshotModules = path.join(opts.snapshotDir, 'node_modules');
  if (warm) {
    await rm(snapshotModules, { recursive: true, force: true });
    await linkTree(warmModules, snapshotModules);
    return { refreshed: false, digest, skipped: false };
  }

  // Drop any hardlinked warm tree before installing so a refresh cannot
  // overwrite the previous fingerprint's cache.
  await rm(snapshotModules, { recursive: true, force: true });
  const code = await opts.install(opts.snapshotDir, storeDir);
  if (code !== 0) {
    throw new Error(`dependency install failed with exit ${code}`);
  }
  if (await exists(snapshotModules)) {
    await mkdir(path.dirname(warmModules), { recursive: true });
    try {
      await execFile('rm', ['-rf', warmModules]);
      await execFile('cp', ['-al', snapshotModules, warmModules]);
    } catch {
      const { cp, rm } = await import('fs/promises');
      await rm(warmModules, { recursive: true, force: true });
      await cp(snapshotModules, warmModules, { recursive: true });
    }
  }
  await mkdir(path.dirname(stampPath), { recursive: true });
  await writeFile(stampPath, JSON.stringify({ digest, at: Date.now() }));
  return { refreshed: true, digest, skipped: false };
}

export function derivedDataDir(cacheDir: string, digest: string): string {
  return path.join(cacheDir, 'derived-data', digest);
}
