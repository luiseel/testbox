import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  AppError,
  chooseSyncTarget,
  createId,
  explainUnsatisfiable,
  hashContent,
  isTerminal,
  JobStore,
  labelsSatisfy,
  queueKeyFor,
  snapshotRel,
  stableStringify,
  stagingRel,
  toPlacementWorkers,
  type JobRecord,
  type LogLine,
  type Principal,
  type SnapshotRecord,
  type WorkerRecord,
  type WorkspaceRecord,
} from '@testbox/shared';
import { APP_OPTIONS, JOB_QUEUE, JOB_STORE, type AppOptions } from './options';

export interface CreateJobInput {
  workspaceId: string;
  snapshotId: string;
  command: string;
  profile?: string | null;
  artifactGlobs?: string[];
  requires?: string[];
  priority?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
  targetWorkerId?: string | null;
}

@Injectable()
export class JobsService {
  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(JOB_QUEUE) private readonly queue: Queue,
    @Inject(APP_OPTIONS) private readonly options: AppOptions,
  ) {}

  async createWorkspace(ownerId: string, project: string): Promise<WorkspaceRecord> {
    const id = createId('ws');
    const workspace: WorkspaceRecord = {
      id,
      project,
      ownerId,
      stagingRel: stagingRel(ownerId, project, id),
      createdAt: Date.now(),
    };
    await this.store.createWorkspace(workspace);
    await this.store.audit({ at: workspace.createdAt, actorId: ownerId, action: 'workspace.create', subject: workspace.id });
    return workspace;
  }

  async listWorkspaces(ownerId: string): Promise<WorkspaceRecord[]> {
    return this.store.listWorkspaces(ownerId);
  }

  async getWorkspace(id: string, ownerId: string): Promise<WorkspaceRecord> {
    const workspace = await this.store.getWorkspace(id);
    if (!workspace || workspace.ownerId !== ownerId) throw new AppError('NOT_FOUND', 'workspace not found', 404);
    return workspace;
  }

  async deleteWorkspace(id: string, ownerId: string): Promise<void> {
    await this.getWorkspace(id, ownerId);
    await this.store.deleteWorkspace(id);
  }

  async registerSnapshot(
    workspaceId: string,
    ownerId: string,
    input: { id: string; digest: string },
  ): Promise<SnapshotRecord> {
    const workspace = await this.getWorkspace(workspaceId, ownerId);
    const existing = await this.store.getSnapshot(input.id);
    if (existing) {
      if (existing.ownerId !== ownerId || existing.digest !== input.digest) {
        throw new AppError('CONFLICT', 'snapshot id already used', 409);
      }
      return existing;
    }
    const snapshot: SnapshotRecord = {
      id: input.id,
      workspaceId: workspace.id,
      ownerId,
      relPath: snapshotRel(input.id),
      digest: input.digest,
      createdAt: Date.now(),
    };
    await this.store.createSnapshot(snapshot);
    return snapshot;
  }

  async createJob(owner: Principal, input: CreateJobInput): Promise<{ job: JobRecord; superseded: string[] }> {
    const workspace = await this.getWorkspace(input.workspaceId, owner.id);
    const snapshot = await this.store.getSnapshot(input.snapshotId);
    if (!snapshot || snapshot.ownerId !== owner.id || snapshot.workspaceId !== workspace.id) {
      throw new AppError('NOT_FOUND', 'snapshot not found', 404);
    }
    const requires = input.requires ?? [];
    await this.assertRunnable(requires, input.targetWorkerId ?? null);
    const profile = input.profile ?? null;
    const body = {
      workspaceId: workspace.id,
      snapshotId: snapshot.id,
      command: input.command,
      profile,
      artifactGlobs: input.artifactGlobs ?? [],
      requires,
      priority: input.priority ?? 0,
      timeoutMs: input.timeoutMs ?? 30 * 60 * 1000,
      targetWorkerId: input.targetWorkerId ?? null,
    };
    const requestHash = hashContent(stableStringify(body));
    if (input.idempotencyKey) {
      return this.store.withLock(`idem:${owner.id}:${input.idempotencyKey}`, async () => {
        const existing = await this.store.getIdempotency(owner.id, input.idempotencyKey!);
        if (existing) {
          if (existing.hash !== requestHash) throw new AppError('CONFLICT', 'idempotency key reused with a different request', 409);
          const job = await this.store.getJob(existing.jobId);
          if (!job) throw new AppError('NOT_FOUND', 'job not found', 404);
          return { job, superseded: [] };
        }
        const created = await this.enqueue(owner.id, workspace.id, snapshot, body);
        await this.store.putIdempotency(owner.id, input.idempotencyKey!, created.job.id, requestHash);
        return created;
      });
    }
    return this.enqueue(owner.id, workspace.id, snapshot, body);
  }

  async getJob(id: string, ownerId: string): Promise<JobRecord> {
    const job = await this.store.getJob(id);
    if (!job || job.ownerId !== ownerId) throw new AppError('NOT_FOUND', 'job not found', 404);
    return job;
  }

  async readLogs(id: string, ownerId: string, offset: number): Promise<{ lines: LogLine[]; state: JobRecord['state'] }> {
    const job = await this.getJob(id, ownerId);
    const lines = await this.store.readLogs(id, offset);
    return { lines, state: job.state };
  }

  async cancel(id: string, ownerId: string): Promise<JobRecord> {
    const job = await this.getJob(id, ownerId);
    if (isTerminal(job.state)) return job;
    await this.store.requestCancel(id);
    if (job.state === 'queued') {
      const result = await this.store.transition(id, ['queued'], 'cancelled', {
        endedAt: Date.now(),
        error: 'cancelled',
      });
      if (result.ok) {
        try {
          await this.queue.remove(id);
        } catch {
          // already active or removed
        }
      }
    }
    await this.store.audit({ at: Date.now(), actorId: ownerId, action: 'job.cancel', subject: id });
    const updated = await this.store.getJob(id);
    if (!updated) throw new AppError('NOT_FOUND', 'job not found', 404);
    return updated;
  }

  async healthyWorkers(requires: string[]): Promise<{ id: string; labels: string[] }[]> {
    const now = Date.now();
    const workers = await this.store.listWorkers();
    return workers.filter(
      (worker) =>
        now - worker.lastSeen <= this.options.heartbeatTtlMs &&
        labelsSatisfy(worker.labels, requires),
    );
  }

  /** Where Mutagen should sync. Prefers the workspace's warm worker. */
  async selectWorker(input: {
    requires?: string[];
    workspaceId?: string | null;
  }): Promise<WorkerRecord> {
    const requires = input.requires ?? [];
    const workers = await this.store.listWorkers();
    const impossible = explainUnsatisfiable(requires, workers);
    if (impossible) throw new AppError('NO_WORKER', impossible, 503);
    const now = Date.now();
    const active = (await this.store.listAllJobs()).filter(
      (job) => job.state === 'assigned' || job.state === 'running',
    );
    const affinity = input.workspaceId ? await this.store.getWorkspaceAffinity(input.workspaceId) : null;
    const chosen = chooseSyncTarget(
      { requires },
      toPlacementWorkers(workers, active),
      affinity,
      now,
      this.options.heartbeatTtlMs,
    );
    const record = chosen ? workers.find((worker) => worker.id === chosen.id) : undefined;
    if (!record) throw new AppError('NO_WORKER', 'no compatible worker is heartbeating', 503);
    return record;
  }

  private async assertRunnable(requires: string[], targetWorkerId: string | null): Promise<void> {
    const workers = await this.store.listWorkers();
    const impossible = explainUnsatisfiable(requires, workers);
    if (impossible) throw new AppError('NO_WORKER', impossible, 503);
    if (!targetWorkerId) return;
    const target = workers.find((worker) => worker.id === targetWorkerId);
    if (!target || !labelsSatisfy(target.labels, requires)) {
      const need = requires.length > 0 ? requires.join(', ') : '(any worker)';
      throw new AppError(
        'NO_WORKER',
        `worker ${targetWorkerId} cannot satisfy required labels: ${need}`,
        503,
      );
    }
  }

  private async enqueue(
    ownerId: string,
    workspaceId: string,
    snapshot: SnapshotRecord,
    body: {
      command: string;
      profile: string | null;
      artifactGlobs: string[];
      requires: string[];
      targetWorkerId: string | null;
      priority: number;
      timeoutMs: number;
      workspaceId: string;
      snapshotId: string;
    },
  ): Promise<{ job: JobRecord; superseded: string[] }> {
    const now = Date.now();
    const job: JobRecord = {
      id: createId('job'),
      workspaceId,
      snapshotId: snapshot.id,
      snapshotRelPath: snapshot.relPath,
      snapshotDigest: snapshot.digest,
      ownerId,
      command: body.command,
      profile: body.profile,
      artifactGlobs: body.artifactGlobs,
      requires: body.requires,
      targetWorkerId: body.targetWorkerId,
      priority: body.priority,
      timeoutMs: body.timeoutMs,
      state: 'queued',
      createdAt: now,
      assignedAt: null,
      startedAt: null,
      endedAt: null,
      workerId: null,
      attemptId: null,
      exitCode: null,
      error: null,
      cancelRequested: false,
      leaseExpiresAt: null,
      pgid: null,
      retentionUntil: now + this.options.retentionMs,
      queueKey: body.profile ? queueKeyFor(this.store.prefix, workspaceId, body.profile) : '',
    };
    const created = await this.store.createJob(job);
    for (const id of created.superseded) {
      try {
        await this.queue.remove(id);
      } catch {
        // the worker may already have claimed it; the state machine blocks re-execution
      }
    }
    await this.store.audit({ at: now, actorId: ownerId, action: 'job.create', subject: job.id });
    return created;
  }
}
