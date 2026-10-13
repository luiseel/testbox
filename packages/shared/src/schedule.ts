import type { JobStore } from './job-store';
import type { JobRecord, ResourceClass, WorkerRecord } from './types';

export interface PlacementWorker {
  id: string;
  labels: string[];
  capacity: number;
  lastSeen: number;
  active: number;
  exclusive: boolean;
  sshHost: string | null;
}

export interface PlacementRequest {
  requires: readonly string[];
  resources: ResourceClass;
  targetWorkerId?: string | null;
}

export function labelsSatisfy(workerLabels: readonly string[], requires: readonly string[]): boolean {
  return requires.every((label) => workerLabels.includes(label));
}

/**
 * Message when no registered worker's labels can ever run this job.
 * Returns null when at least one registered worker has the required labels.
 */
export function explainUnsatisfiable(
  requires: readonly string[],
  workers: readonly { id: string; labels: readonly string[] }[],
): string | null {
  if (workers.some((worker) => labelsSatisfy(worker.labels, requires))) return null;
  if (workers.length === 0) {
    return 'no registered worker can satisfy this job; no workers are registered';
  }
  const need = requires.length > 0 ? requires.join(', ') : '(any worker)';
  const registered = workers.map((worker) => `${worker.id} [${worker.labels.join(', ')}]`).join('; ');
  return `no registered worker can satisfy required labels: ${need}; registered: ${registered}`;
}

export function rankQueuedJobs<T extends { priority: number; createdAt: number; id: string }>(
  jobs: readonly T[],
): T[] {
  return [...jobs].sort(
    (a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

export function toPlacementWorkers(workers: readonly WorkerRecord[], active: readonly JobRecord[]): PlacementWorker[] {
  return workers.map((worker) => {
    const mine = active.filter(
      (job) => job.workerId === worker.id && (job.state === 'assigned' || job.state === 'running'),
    );
    return {
      id: worker.id,
      labels: worker.labels,
      capacity: worker.capacity > 0 ? worker.capacity : 1,
      lastSeen: worker.lastSeen,
      active: mine.length,
      exclusive: mine.some((job) => job.resources === 'exclusive'),
      sshHost: worker.sshHost ?? null,
    };
  });
}

export function workerIsHealthy(worker: PlacementWorker, now: number, heartbeatTtlMs: number): boolean {
  return now - worker.lastSeen <= heartbeatTtlMs;
}

/**
 * A worker can take a job when it is healthy, its labels cover `requires`,
 * it is the pinned worker when one is set, and it has a free slot.
 * An exclusive job needs the machine to itself. A running exclusive job
 * occupies the worker completely.
 */
export function workerCanRun(
  worker: PlacementWorker,
  job: PlacementRequest,
  now: number,
  heartbeatTtlMs: number,
): boolean {
  if (!workerIsHealthy(worker, now, heartbeatTtlMs)) return false;
  if (job.targetWorkerId && job.targetWorkerId !== worker.id) return false;
  if (!labelsSatisfy(worker.labels, job.requires)) return false;
  if (worker.exclusive) return false;
  if (job.resources === 'exclusive') return worker.active === 0;
  return worker.active < worker.capacity;
}

/** Prefer the workspace's warm worker, then the worker with the most free slots. */
export function chooseWorker(
  job: PlacementRequest,
  workers: readonly PlacementWorker[],
  affinityId: string | null,
  now: number,
  heartbeatTtlMs: number,
): PlacementWorker | null {
  const eligible = workers.filter((worker) => workerCanRun(worker, job, now, heartbeatTtlMs));
  if (eligible.length === 0) return null;
  if (affinityId) {
    const preferred = eligible.find((worker) => worker.id === affinityId);
    if (preferred) return preferred;
  }
  return [...eligible].sort((a, b) => a.active - b.active || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * Worker the CLI should sync to. Capacity is ignored so a busy affinity
 * worker can still receive the staging tree; the job waits for a free slot.
 */
export function chooseSyncTarget(
  job: PlacementRequest,
  workers: readonly PlacementWorker[],
  affinityId: string | null,
  now: number,
  heartbeatTtlMs: number,
): PlacementWorker | null {
  const eligible = workers.filter(
    (worker) => workerIsHealthy(worker, now, heartbeatTtlMs) && labelsSatisfy(worker.labels, job.requires),
  );
  if (eligible.length === 0) return null;
  if (affinityId) {
    const preferred = eligible.find((worker) => worker.id === affinityId);
    if (preferred) return preferred;
  }
  return [...eligible].sort((a, b) => a.active - b.active || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * Claim the next queued job this worker should run.
 * Higher priority first, then FIFO. Workspace affinity wins when that worker can take the job.
 */
export async function claimNextJob(
  store: JobStore,
  workerId: string,
  now: number,
  heartbeatTtlMs: number,
  leaseMs: number,
): Promise<JobRecord | null> {
  return store.withLock('scheduler', async () => {
    const workers = await store.listWorkers();
    const records = await store.listAllJobs();
    const active = records.filter((job) => job.state === 'assigned' || job.state === 'running');
    const placement = toPlacementWorkers(workers, active);
    const me = placement.find((worker) => worker.id === workerId);
    if (!me || !workerIsHealthy(me, now, heartbeatTtlMs)) return null;
    if (me.exclusive || me.active >= me.capacity) return null;

    const queued = rankQueuedJobs(records.filter((job) => job.state === 'queued'));
    for (const job of queued) {
      const affinity = await store.getWorkspaceAffinity(job.workspaceId);
      const chosen = chooseWorker(job, placement, affinity, now, heartbeatTtlMs);
      if (!chosen || chosen.id !== workerId) continue;
      const result = await store.transition(job.id, ['queued'], 'assigned', {
        workerId,
        attemptId: `attempt_${job.id}`,
        assignedAt: now,
        leaseExpiresAt: now + leaseMs,
      });
      if (!result.ok) continue;
      await store.setWorkspaceAffinity(job.workspaceId, workerId);
      return store.getJob(job.id);
    }
    return null;
  });
}
