import type { JobStore } from './job-store';
import type { JobRecord, WorkerRecord } from './types';

export interface PlacementWorker {
  id: string;
  labels: string[];
  capacity: number;
  lastSeen: number;
  active: number;
  /** Queued jobs pinned to this worker: the CLI synced them there, so they wait for its slot. */
  waiting: number;
  /** When this worker last got or ended a job; 0 when no job record is left. */
  lastJobAt: number;
  sshHost: string | null;
}

export interface PlacementRequest {
  requires: readonly string[];
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

export function toPlacementWorkers(workers: readonly WorkerRecord[], jobs: readonly JobRecord[]): PlacementWorker[] {
  return workers.map((worker) => {
    const mine = jobs.filter((job) => job.workerId === worker.id);
    const waiting = jobs.filter((job) => job.state === 'queued' && job.targetWorkerId === worker.id);
    return {
      id: worker.id,
      labels: worker.labels,
      capacity: worker.capacity > 0 ? worker.capacity : 1,
      lastSeen: worker.lastSeen,
      active: mine.filter((job) => job.state === 'assigned' || job.state === 'running').length,
      waiting: waiting.length,
      lastJobAt: Math.max(0, ...mine.map((job) => Math.max(job.assignedAt ?? 0, job.endedAt ?? 0))),
      sshHost: worker.sshHost ?? null,
    };
  });
}

/** Slots left after the active jobs and the jobs that wait for this worker. Below 0 when jobs wait. */
function freeSlots(worker: PlacementWorker): number {
  return worker.capacity - worker.active - worker.waiting;
}

/** Most free slots first, then the worker that was idle longest, so equal workers take turns. */
function leastLoaded(workers: readonly PlacementWorker[]): PlacementWorker | null {
  return (
    [...workers].sort(
      (a, b) => freeSlots(b) - freeSlots(a) || a.lastJobAt - b.lastJobAt || a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

export function workerIsHealthy(worker: PlacementWorker, now: number, heartbeatTtlMs: number): boolean {
  return now - worker.lastSeen <= heartbeatTtlMs;
}

/**
 * A worker can take a job when it is healthy, its labels cover `requires`,
 * it is the pinned worker when one is set, and it has a free slot.
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
  return leastLoaded(eligible);
}

/**
 * Worker the CLI should sync to. The warm worker wins while it has a free slot.
 * Otherwise the least-loaded worker with the labels wins; the warm worker wins a tie.
 * Jobs that already wait for a worker count as its load.
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
  const preferred = affinityId ? eligible.find((worker) => worker.id === affinityId) : undefined;
  if (preferred && freeSlots(preferred) > 0) return preferred;
  const best = leastLoaded(eligible);
  if (preferred && best && freeSlots(best) <= freeSlots(preferred)) return preferred;
  return best;
}

/** Longer than a claim from a worker on a slow link to Redis can take. */
const CLAIM_LOCK_TTL_MS = 60_000;

/**
 * Claim the next queued job this worker should run.
 * Higher priority first, then FIFO. Workspace affinity wins when that worker can take the job.
 * The clock is read after the reads and again at the assignment, so a slow link to Redis does not shorten the lease.
 */
export async function claimNextJob(
  store: JobStore,
  workerId: string,
  clock: () => number,
  heartbeatTtlMs: number,
  leaseMs: number,
): Promise<JobRecord | null> {
  return store.withLock('scheduler', async () => {
    const workers = await store.listWorkers();
    const records = await store.listAllJobs();
    const now = clock();
    const placement = toPlacementWorkers(workers, records);
    const me = placement.find((worker) => worker.id === workerId);
    if (!me || !workerIsHealthy(me, now, heartbeatTtlMs)) return null;
    if (me.active >= me.capacity) return null;

    const queued = rankQueuedJobs(records.filter((job) => job.state === 'queued'));
    const affinities = await store.getWorkspaceAffinities(queued.map((job) => job.workspaceId));
    for (const job of queued) {
      const affinity = affinities.get(job.workspaceId) ?? null;
      const chosen = chooseWorker(job, placement, affinity, now, heartbeatTtlMs);
      if (!chosen || chosen.id !== workerId) continue;
      const assignedAt = clock();
      const result = await store.transition(job.id, ['queued'], 'assigned', {
        workerId,
        attemptId: `attempt_${job.id}`,
        assignedAt,
        leaseExpiresAt: assignedAt + leaseMs,
      });
      if (!result.ok) continue;
      await store.setWorkspaceAffinity(job.workspaceId, workerId);
      return store.getJob(job.id);
    }
    return null;
  }, CLAIM_LOCK_TTL_MS);
}
