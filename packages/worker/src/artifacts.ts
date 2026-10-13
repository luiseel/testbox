import { readdir, stat } from 'fs/promises';
import path from 'path';
import { matchGlob } from '@testbox/shared';

export interface ArtifactFile {
  relPath: string;
  absPath: string;
  size: number;
}

export async function collectArtifacts(
  root: string,
  patterns: readonly string[],
  maxFileBytes: number,
): Promise<ArtifactFile[]> {
  if (patterns.length === 0) return [];
  const rootAbs = path.resolve(root);
  const found: ArtifactFile[] = [];

  async function considerFile(abs: string, rel: string): Promise<void> {
    const info = await stat(abs);
    if (!info.isFile()) return;
    if (info.size > maxFileBytes) return;
    const resolved = path.resolve(abs);
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) return;
    found.push({ relPath: rel, absPath: resolved, size: info.size });
  }

  async function walk(dir: string, relDir: string, force: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const matched = patterns.some((pattern) => matchGlob(rel, pattern));
        await walk(abs, rel, force || matched);
      } else if (entry.isFile()) {
        const matched = force || patterns.some((pattern) => matchGlob(rel, pattern));
        if (matched) await considerFile(abs, rel);
      }
    }
  }

  await walk(rootAbs, '', false);
  return found;
}
