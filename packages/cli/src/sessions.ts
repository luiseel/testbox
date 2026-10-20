import { access } from 'fs/promises';
import type { MutagenSessionInfo } from '@testbox/shared';
import { readWorkspaceState, type WorkspaceState } from './config-store';

/** What is at the local root of a session: nothing, a directory without a state file, or a checkout with one. */
export type RootState = 'missing' | WorkspaceState | null;

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

function sessionNames(state: WorkspaceState): string[] {
  return [state.sessionName, ...Object.values(state.sessions ?? {}).map((session) => session.sessionName)];
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
    const kind: SessionKind =
      state === 'missing' ? 'missing-root' : state && sessionNames(state).includes(session.name) ? 'live' : 'unowned';
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

/** Read a local root from disk for classifySessions. An unreadable state file counts as no owner. */
export async function loadRootState(root: string): Promise<RootState> {
  try {
    await access(root);
  } catch {
    return 'missing';
  }
  try {
    return await readWorkspaceState(root);
  } catch {
    return null;
  }
}
