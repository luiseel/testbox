import { readdir, readFile, rm, mkdir, writeFile } from 'fs/promises';
import path from 'path';

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RetentionKind = 'artifacts' | 'logs' | 'snapshots';

export function retentionFile(dataDir: string, kind: RetentionKind, id: string): string {
  return path.join(dataDir, 'retention', `${kind}__${id}.json`);
}

export async function writeRetention(
  dataDir: string,
  kind: RetentionKind,
  id: string,
  until: number,
): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('unsafe retention id');
  const file = retentionFile(dataDir, kind, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ kind, id, until }));
}

/**
 * Deletes expired snapshots, logs, and artifacts.
 * Directories under `cache/` and `workspaces/` are never removed.
 */
export async function cleanupExpired(
  dataDir: string,
  now: number,
): Promise<{ removed: string[] }> {
  const index = path.join(dataDir, 'retention');
  let names: string[] = [];
  try {
    names = await readdir(index);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: [] };
    throw err;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(index, name);
    let record: { kind?: RetentionKind; id?: string; until?: number };
    try {
      record = JSON.parse(await readFile(file, 'utf8')) as typeof record;
    } catch {
      continue;
    }
    if (!record.kind || !record.id || typeof record.until !== 'number') continue;
    if (record.until > now) continue;
    if (!['artifacts', 'logs', 'snapshots'].includes(record.kind)) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(record.id)) continue;
    const target = path.join(dataDir, record.kind, record.id);
    const cache = path.resolve(dataDir, 'cache');
    const resolved = path.resolve(target);
    if (resolved === cache || resolved.startsWith(cache + path.sep)) continue;
    await rm(resolved, { recursive: true, force: true });
    await rm(file, { force: true });
    removed.push(path.relative(dataDir, resolved));
  }
  return { removed };
}
