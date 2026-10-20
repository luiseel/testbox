import path from 'path';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function assertSafeSegment(value: string, label = 'segment'): void {
  if (!SEGMENT.test(value)) {
    throw new Error(`${label} must match ${SEGMENT.source}`);
  }
}

export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) throw new Error('path contains NUL');
  if (path.isAbsolute(rel)) throw new Error('absolute path is not allowed');
  const parts = rel.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error('empty relative path');
  if (parts.some((p) => p === '..' || p === '.')) throw new Error('path escape');
  const abs = path.resolve(root, ...parts);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error('path escape');
  }
  return abs;
}

/** Each workspace (one checkout of a repo) gets its own folder, so two checkouts never sync into one folder. */
export function stagingRel(userId: string, project: string, workspaceId: string): string {
  assertSafeSegment(userId, 'user id');
  assertSafeSegment(project, 'project');
  assertSafeSegment(workspaceId, 'workspace id');
  return path.posix.join('workspaces', userId, project, workspaceId);
}

export function snapshotRel(snapshotId: string): string {
  assertSafeSegment(snapshotId, 'snapshot id');
  return path.posix.join('snapshots', snapshotId);
}
