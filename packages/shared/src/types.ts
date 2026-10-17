import type { JobState } from './states';

export type PrincipalRole = 'admin' | 'user' | 'worker';

export interface Principal {
  id: string;
  role: PrincipalRole;
  name: string;
}

export interface UserRecord {
  id: string;
  name: string;
  role: Exclude<PrincipalRole, 'worker'>;
  createdAt: number;
}

export interface WorkerRecord {
  id: string;
  hostname: string;
  os: string;
  arch: string;
  labels: string[];
  capacity: number;
  lastSeen: number;
  /** SSH destination for Mutagen, for example `testbox@builder-1`. */
  sshHost: string | null;
}

export interface WorkspaceRecord {
  id: string;
  project: string;
  ownerId: string;
  stagingRel: string;
  createdAt: number;
}

export interface SnapshotRecord {
  id: string;
  workspaceId: string;
  ownerId: string;
  relPath: string;
  digest: string;
  createdAt: number;
}

export interface JobRecord {
  id: string;
  workspaceId: string;
  snapshotId: string;
  snapshotRelPath: string;
  snapshotDigest: string;
  ownerId: string;
  command: string;
  profile: string | null;
  artifactGlobs: string[];
  requires: string[];
  priority: number;
  timeoutMs: number;
  state: JobState;
  createdAt: number;
  assignedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  workerId: string | null;
  /** When set, only this worker may run the job (the snapshot lives on its disk). */
  targetWorkerId: string | null;
  attemptId: string | null;
  exitCode: number | null;
  error: string | null;
  cancelRequested: boolean;
  leaseExpiresAt: number | null;
  pgid: number | null;
  retentionUntil: number;
  queueKey: string;
}

export interface LogLine {
  offset: number;
  stream: 'stdout' | 'stderr';
  line: string;
}

export type JobEvent =
  | ({ jobId: string; type: 'log' } & LogLine)
  | {
      jobId: string;
      type: 'state';
      state: JobState;
      exitCode: number | null;
      error: string | null;
    }
  | { jobId: string; type: 'cancel' };

export interface AuditEntry {
  at: number;
  actorId: string;
  action: string;
  subject?: string;
}
