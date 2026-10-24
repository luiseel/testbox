import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Package.resolved',
  'Podfile.lock',
] as const;

export interface RuntimeFacts {
  nodeVersion: string | null;
  arch: string;
  platform: string;
  xcodeVersion: string | null;
}

export interface DependencyFingerprint {
  version: 1;
  lockfiles: Record<string, string>;
  nodeVersion: string | null;
  arch: string;
  platform: string;
  xcodeVersion: string | null;
}

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function buildFingerprint(lockfiles: Record<string, string>, runtime: RuntimeFacts): DependencyFingerprint {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(lockfiles).sort()) sorted[key] = lockfiles[key];
  return {
    version: 1,
    lockfiles: sorted,
    nodeVersion: runtime.nodeVersion,
    arch: runtime.arch,
    platform: runtime.platform,
    xcodeVersion: runtime.xcodeVersion,
  };
}

export function fingerprintDigest(fp: DependencyFingerprint): string {
  return hashContent(stableStringify(fp));
}

export function needsDependencyRefresh(previous: DependencyFingerprint | null, next: DependencyFingerprint): boolean {
  if (!previous) return true;
  return fingerprintDigest(previous) !== fingerprintDigest(next);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'DerivedData', 'dist', 'build', 'coverage', '.next']);

export async function collectLockfiles(root: string): Promise<Record<string, string>> {
  const names = new Set<string>(LOCKFILE_NAMES);
  const found: Record<string, string> = {};
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (entry.isFile() && names.has(entry.name)) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        found[rel] = hashContent(await readFile(abs));
      }
    }
  }
  await walk(root, 0);
  return found;
}

export async function fingerprintFromDirectory(root: string, runtime: RuntimeFacts): Promise<DependencyFingerprint> {
  return buildFingerprint(await collectLockfiles(root), runtime);
}
