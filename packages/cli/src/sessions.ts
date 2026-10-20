import { access } from 'fs/promises';
import type { MutagenSessionInfo } from '@testbox/shared';
import { readWorkspaceState, workspaceSessionNames, type WorkspaceState } from './config-store';

/**
 * What is at the local root of a session: nothing, a directory without a state file, a checkout
 * with one, or a state file that cannot be read now (for example, while start writes it).
 */
export type RootState = 'missing' | 'unreadable' | WorkspaceState | null;

export type SessionKind = 'missing-root' | 'unowned' | 'live';

export interface ClassifiedSession {
  session: MutagenSessionInfo;
  kind: SessionKind;
}

/** Two or more checkouts that sync into the same worker folder. Each job then tests the files of the last writer. */
export interface SharedDestination {
  betaUrl: string;
  roots: string[];
  sessions: string[];
}

export interface SessionReport {
  sessions: ClassifiedSession[];
  conflicts: SharedDestination[];
}

/** Why a session is stale, for doctor and prune output. */
export function staleReason(kind: SessionKind): string {
  return kind === 'missing-root' ? 'root deleted' : 'no workspace owns it';
}

/** Sort the testbox sessions into stale and live ones, and find live ones that share a destination. */
export async function classifySessions(
  sessions: MutagenSessionInfo[],
  loadRoot: (root: string) => Promise<RootState>,
): Promise<SessionReport> {
  const cache = new Map<string, Promise<RootState>>();
  const classified: ClassifiedSession[] = [];
  for (const session of sessions) {
    if (!session.name.startsWith('testbox-')) continue;
    let root = cache.get(session.alphaPath);
    if (!root) {
      root = loadRoot(session.alphaPath);
      cache.set(session.alphaPath, root);
    }
    const state = await root;
    let kind: SessionKind = 'unowned';
    if (state === 'missing') kind = 'missing-root';
    else if (state === 'unreadable') kind = 'live';
    else if (state && workspaceSessionNames(state).includes(session.name)) kind = 'live';
    classified.push({ session, kind });
  }

  const byDestination = new Map<string, ClassifiedSession[]>();
  for (const entry of classified) {
    if (entry.kind !== 'live') continue;
    const group = byDestination.get(entry.session.betaUrl) ?? [];
    group.push(entry);
    byDestination.set(entry.session.betaUrl, group);
  }
  const conflicts: SharedDestination[] = [];
  for (const [betaUrl, group] of byDestination) {
    const roots = [...new Set(group.map((entry) => entry.session.alphaPath))];
    if (roots.length < 2) continue;
    conflicts.push({ betaUrl, roots, sessions: group.map((entry) => entry.session.name) });
  }
  return { sessions: classified, conflicts };
}

/** Read a local root from disk for classifySessions. A state file that cannot be read keeps its sessions. */
export async function loadRootState(root: string): Promise<RootState> {
  try {
    await access(root);
  } catch {
    return 'missing';
  }
  try {
    return await readWorkspaceState(root);
  } catch {
    return 'unreadable';
  }
}
