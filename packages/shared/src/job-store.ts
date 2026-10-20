import { randomBytes, createHash } from 'crypto';
import type { Redis } from 'ioredis';
import { isTerminal, type JobState } from './states';
import type {
  AuditEntry,
  JobEvent,
  JobRecord,
  LogLine,
  SnapshotRecord,
  UserRecord,
  WorkerRecord,
  WorkspaceRecord,
} from './types';
import type { JobSource } from './source';

const TRANSITION_LUA = `
local key = KEYS[1]
local fromCsv = ARGV[1]
local toState = ARGV[2]
local n = tonumber(ARGV[3])
local state = redis.call('HGET', key, 'state')
if not state then
  return {'missing', ''}
end
if state == 'succeeded' or state == 'failed' or state == 'cancelled' or state == 'timed_out' then
  return {'terminal', state}
end
local allowed = false
for part in string.gmatch(fromCsv, '[^,]+') do
  if part == state then
    allowed = true
    break
  end
end
if not allowed then
  return {'mismatch', state}
end
redis.call('HSET', key, 'state', toState)
for i = 1, n do
  local field = ARGV[3 + (i - 1) * 2 + 1]
  local value = ARGV[3 + (i - 1) * 2 + 2]
  redis.call('HSET', key, field, value)
end
return {'ok', toState}
`;

const RENEW_LUA = `
local key = KEYS[1]
local workerId = ARGV[1]
local expires = ARGV[2]
local state = redis.call('HGET', key, 'state')
if state ~= 'assigned' and state ~= 'running' then
  return {'terminal', state or 'missing'}
end
local owner = redis.call('HGET', key, 'workerId')
if owner ~= workerId then
  return {'mismatch', state}
end
redis.call('HSET', key, 'leaseExpiresAt', expires)
return {'ok', state}
`;

export interface TransitionResult {
  ok: boolean;
  reason: string;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function encodeJob(job: JobRecord): Record<string, string> {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    snapshotId: job.snapshotId,
    snapshotRelPath: job.snapshotRelPath,
    snapshotDigest: job.snapshotDigest,
    ownerId: job.ownerId,
    command: job.command,
    profile: job.profile ?? '',
    artifactGlobs: JSON.stringify(job.artifactGlobs),
    requires: JSON.stringify(job.requires),
    priority: String(job.priority),
    timeoutMs: String(job.timeoutMs),
    state: job.state,
    createdAt: String(job.createdAt),
    assignedAt: job.assignedAt === null ? '' : String(job.assignedAt),
    startedAt: job.startedAt === null ? '' : String(job.startedAt),
    endedAt: job.endedAt === null ? '' : String(job.endedAt),
    workerId: job.workerId ?? '',
    targetWorkerId: job.targetWorkerId ?? '',
    source: job.source ? JSON.stringify(job.source) : '',
    attemptId: job.attemptId ?? '',
    exitCode: job.exitCode === null ? '' : String(job.exitCode),
    error: job.error ?? '',
    cancelRequested: job.cancelRequested ? '1' : '0',
    leaseExpiresAt: job.leaseExpiresAt === null ? '' : String(job.leaseExpiresAt),
    pgid: job.pgid === null ? '' : String(job.pgid),
    retentionUntil: String(job.retentionUntil),
    queueKey: job.queueKey,
  };
}

function decodeJob(raw: Record<string, string>): JobRecord | null {
  if (!raw.id || !raw.state) return null;
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    snapshotId: raw.snapshotId,
    snapshotRelPath: raw.snapshotRelPath,
    snapshotDigest: raw.snapshotDigest,
    ownerId: raw.ownerId,
    command: raw.command,
    profile: raw.profile ? raw.profile : null,
    artifactGlobs: JSON.parse(raw.artifactGlobs || '[]') as string[],
    requires: JSON.parse(raw.requires || '[]') as string[],
    priority: Number(raw.priority || 0),
    timeoutMs: Number(raw.timeoutMs || 0),
    state: raw.state as JobState,
    createdAt: Number(raw.createdAt || 0),
    assignedAt: num(raw.assignedAt),
    startedAt: num(raw.startedAt),
    endedAt: num(raw.endedAt),
    workerId: raw.workerId || null,
    targetWorkerId: raw.targetWorkerId || null,
    source: raw.source ? (JSON.parse(raw.source) as JobSource) : null,
    attemptId: raw.attemptId || null,
    exitCode: num(raw.exitCode),
    error: raw.error || null,
    cancelRequested: raw.cancelRequested === '1',
    leaseExpiresAt: num(raw.leaseExpiresAt),
    pgid: num(raw.pgid),
    retentionUntil: Number(raw.retentionUntil || 0),
    queueKey: raw.queueKey || '',
  };
}

export function queueKeyFor(prefix: string, workspaceId: string, profile: string): string {
  return `${prefix}:q:${workspaceId}:${encodeURIComponent(profile)}`;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class JobStore {
  constructor(
    readonly redis: Redis,
    readonly prefix: string,
  ) {}

  k(suffix: string): string {
    return `${this.prefix}:${suffix}`;
  }

  private jobKey(id: string): string {
    return this.k(`job:${id}`);
  }

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const key = this.k(`lock:${name}`);
    const token = randomBytes(8).toString('hex');
    for (let attempt = 0; attempt < 50; attempt++) {
      const ok = await this.redis.set(key, token, 'PX', 5000, 'NX');
      if (ok === 'OK') {
        try {
          return await fn();
        } finally {
          await this.redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            key,
            token,
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for lock ${name}`);
  }

  async createUser(user: UserRecord): Promise<void> {
    await this.redis.hset(this.k(`user:${user.id}`), {
      id: user.id,
      name: user.name,
      role: user.role,
      createdAt: String(user.createdAt),
    });
    await this.redis.set(this.k(`user-name:${user.name}`), user.id);
    await this.redis.sadd(this.k('users'), user.id);
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const raw = await this.redis.hgetall(this.k(`user:${id}`));
    if (!raw.id) return null;
    return {
      id: raw.id,
      name: raw.name,
      role: raw.role === 'admin' ? 'admin' : 'user',
      createdAt: Number(raw.createdAt || 0),
    };
  }

  async findUserByName(name: string): Promise<UserRecord | null> {
    const id = await this.redis.get(this.k(`user-name:${name}`));
    if (!id) return null;
    return this.getUser(id);
  }

  async saveToken(hash: string, userId: string, role: string): Promise<void> {
    await this.redis.set(this.k(`token:${hash}`), JSON.stringify({ userId, role }));
  }

  async getToken(hash: string): Promise<{ userId: string; role: string } | null> {
    const raw = await this.redis.get(this.k(`token:${hash}`));
    if (!raw) return null;
    return JSON.parse(raw) as { userId: string; role: string };
  }

  async createWorkspace(workspace: WorkspaceRecord): Promise<void> {
    await this.redis.hset(this.k(`ws:${workspace.id}`), {
      id: workspace.id,
      project: workspace.project,
      ownerId: workspace.ownerId,
      stagingRel: workspace.stagingRel,
      createdAt: String(workspace.createdAt),
    });
    await this.redis.sadd(this.k(`user:${workspace.ownerId}:workspaces`), workspace.id);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const raw = await this.redis.hgetall(this.k(`ws:${id}`));
    if (!raw.id) return null;
    return {
      id: raw.id,
      project: raw.project,
      ownerId: raw.ownerId,
      stagingRel: raw.stagingRel,
      createdAt: Number(raw.createdAt || 0),
    };
  }

  async listWorkspaces(ownerId: string): Promise<WorkspaceRecord[]> {
    const ids = await this.redis.smembers(this.k(`user:${ownerId}:workspaces`));
    const rows: WorkspaceRecord[] = [];
    for (const id of ids) {
      const workspace = await this.getWorkspace(id);
      if (workspace) rows.push(workspace);
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  async deleteWorkspace(id: string): Promise<void> {
    const workspace = await this.getWorkspace(id);
    if (!workspace) return;
    await this.redis.del(this.k(`ws:${id}`));
    await this.redis.srem(this.k(`user:${workspace.ownerId}:workspaces`), id);
  }

  async createSnapshot(snapshot: SnapshotRecord): Promise<void> {
    await this.redis.hset(this.k(`snap:${snapshot.id}`), {
      id: snapshot.id,
      workspaceId: snapshot.workspaceId,
      ownerId: snapshot.ownerId,
      relPath: snapshot.relPath,
      digest: snapshot.digest,
      createdAt: String(snapshot.createdAt),
    });
  }

  async getSnapshot(id: string): Promise<SnapshotRecord | null> {
    const raw = await this.redis.hgetall(this.k(`snap:${id}`));
    if (!raw.id) return null;
    return {
      id: raw.id,
      workspaceId: raw.workspaceId,
      ownerId: raw.ownerId,
      relPath: raw.relPath,
      digest: raw.digest,
      createdAt: Number(raw.createdAt || 0),
    };
  }

  async createJob(job: JobRecord): Promise<{ job: JobRecord; superseded: string[] }> {
    return this.withLock(`ws:${job.workspaceId}`, async () => {
      const superseded: string[] = [];
      if (job.profile && job.queueKey) {
        const ids = await this.redis.smembers(job.queueKey);
        for (const id of ids) {
          const result = await this.transition(id, ['queued'], 'cancelled', {
            endedAt: Date.now(),
            error: 'superseded',
          });
          if (result.ok) superseded.push(id);
        }
      }
      await this.redis.hset(this.jobKey(job.id), encodeJob(job));
      await this.redis.sadd(this.k(`user:${job.ownerId}:jobs`), job.id);
      await this.redis.sadd(this.k(`ws:${job.workspaceId}:jobs`), job.id);
      if (job.queueKey) await this.redis.sadd(job.queueKey, job.id);
      await this.publish({
        jobId: job.id,
        type: 'state',
        state: job.state,
        exitCode: null,
        error: null,
      });
      return { job, superseded };
    });
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const raw = await this.redis.hgetall(this.jobKey(id));
    return decodeJob(raw);
  }

  async transition(
    id: string,
    from: JobState[],
    to: JobState,
    patch: Partial<Record<string, string | number | null>> = {},
  ): Promise<TransitionResult> {
    const flat: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) continue;
      flat.push(key, String(value));
    }
    const result = (await this.redis.eval(
      TRANSITION_LUA,
      1,
      this.jobKey(id),
      from.join(','),
      to,
      String(flat.length / 2),
      ...flat,
    )) as [string, string];
    const ok = result[0] === 'ok';
    if (!ok) return { ok: false, reason: result[0] === 'terminal' ? 'terminal' : result[1] || result[0] };
    const job = await this.getJob(id);
    if (job?.queueKey) await this.redis.srem(job.queueKey, id);
    if (to === 'assigned' || to === 'running') await this.redis.sadd(this.k('active'), id);
    if (isTerminal(to)) await this.redis.srem(this.k('active'), id);
    await this.publish({
      jobId: id,
      type: 'state',
      state: to,
      exitCode: job?.exitCode ?? null,
      error: job?.error ?? null,
    });
    return { ok: true, reason: to };
  }

  async renewLease(
    id: string,
    workerId: string,
    leaseExpiresAt: number,
  ): Promise<{ ok: boolean; state: string }> {
    const result = (await this.redis.eval(
      RENEW_LUA,
      1,
      this.jobKey(id),
      workerId,
      String(leaseExpiresAt),
    )) as [string, string];
    return { ok: result[0] === 'ok', state: result[1] };
  }

  async listActiveJobs(): Promise<JobRecord[]> {
    const ids = await this.redis.smembers(this.k('active'));
    const jobs: JobRecord[] = [];
    for (const id of ids) {
      const job = await this.getJob(id);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  async expireLeases(now: number): Promise<string[]> {
    const expired: string[] = [];
    for (const job of await this.listActiveJobs()) {
      if (
        (job.state === 'assigned' || job.state === 'running') &&
        job.leaseExpiresAt !== null &&
        job.leaseExpiresAt <= now
      ) {
        const result = await this.transition(job.id, ['assigned', 'running'], 'timed_out', {
          endedAt: now,
          error: 'lease_expired',
        });
        if (result.ok) expired.push(job.id);
      }
    }
    return expired;
  }

  async appendLog(jobId: string, stream: 'stdout' | 'stderr', line: string): Promise<number> {
    const offset = await this.redis.incr(this.k(`job:${jobId}:seq`));
    const payload = JSON.stringify({ offset, stream, line });
    const key = this.k(`job:${jobId}:logs`);
    await this.redis.rpush(key, payload);
    await this.redis.ltrim(key, -20_000, -1);
    await this.publish({ jobId, type: 'log', offset, stream, line });
    return offset;
  }

  async readLogs(jobId: string, fromOffset: number): Promise<LogLine[]> {
    const rows = await this.redis.lrange(this.k(`job:${jobId}:logs`), 0, -1);
    const lines: LogLine[] = [];
    for (const row of rows) {
      const parsed = JSON.parse(row) as LogLine;
      if (parsed.offset >= fromOffset) lines.push(parsed);
    }
    return lines;
  }

  async requestCancel(id: string): Promise<void> {
    await this.redis.hset(this.jobKey(id), 'cancelRequested', '1');
    await this.publish({ jobId: id, type: 'cancel' });
  }

  async upsertWorker(worker: WorkerRecord): Promise<void> {
    await this.redis.hset(this.k(`worker:${worker.id}`), {
      id: worker.id,
      hostname: worker.hostname,
      os: worker.os,
      arch: worker.arch,
      labels: JSON.stringify(worker.labels),
      capacity: String(worker.capacity),
      lastSeen: String(worker.lastSeen),
      sshHost: worker.sshHost ?? '',
    });
    await this.redis.sadd(this.k('workers'), worker.id);
  }

  async getWorker(id: string): Promise<WorkerRecord | null> {
    const workers = await this.listWorkers();
    return workers.find((worker) => worker.id === id) ?? null;
  }

  async setWorkspaceAffinity(workspaceId: string, workerId: string): Promise<void> {
    await this.redis.set(this.k(`affinity:${workspaceId}`), workerId);
  }

  async getWorkspaceAffinity(workspaceId: string): Promise<string | null> {
    return this.redis.get(this.k(`affinity:${workspaceId}`));
  }

  async listWorkers(): Promise<WorkerRecord[]> {
    const ids = await this.redis.smembers(this.k('workers'));
    const workers: WorkerRecord[] = [];
    for (const id of ids) {
      const raw = await this.redis.hgetall(this.k(`worker:${id}`));
      if (!raw.id) continue;
      workers.push({
        id: raw.id,
        hostname: raw.hostname,
        os: raw.os,
        arch: raw.arch,
        labels: JSON.parse(raw.labels || '[]') as string[],
        capacity: Number(raw.capacity || 1),
        lastSeen: Number(raw.lastSeen || 0),
        sshHost: raw.sshHost || null,
      });
    }
    return workers;
  }

  async getIdempotency(userId: string, key: string): Promise<{ jobId: string; hash: string } | null> {
    const raw = await this.redis.get(this.k(`idem:${userId}:${key}`));
    if (!raw) return null;
    const [jobId, hash] = raw.split('|');
    if (!jobId || !hash) return null;
    return { jobId, hash };
  }

  async putIdempotency(userId: string, key: string, jobId: string, hash: string): Promise<boolean> {
    const ok = await this.redis.set(this.k(`idem:${userId}:${key}`), `${jobId}|${hash}`, 'EX', 86_400, 'NX');
    return ok === 'OK';
  }

  async audit(entry: AuditEntry): Promise<void> {
    await this.redis.lpush(this.k('audit'), JSON.stringify(entry));
    await this.redis.ltrim(this.k('audit'), 0, 999);
  }

  async listAudit(): Promise<AuditEntry[]> {
    const rows = await this.redis.lrange(this.k('audit'), 0, 200);
    return rows.map((row) => JSON.parse(row) as AuditEntry);
  }

  async setPgid(id: string, pgid: number): Promise<void> {
    const job = await this.getJob(id);
    if (!job || isTerminal(job.state)) return;
    await this.redis.hset(this.jobKey(id), 'pgid', String(pgid));
  }

  async listAllJobs(): Promise<JobRecord[]> {
    const userIds = await this.redis.smembers(this.k('users'));
    const jobs: JobRecord[] = [];
    for (const userId of userIds) {
      const jobIds = await this.redis.smembers(this.k(`user:${userId}:jobs`));
      for (const jobId of jobIds) {
        const job = await this.getJob(jobId);
        if (job) jobs.push(job);
      }
    }
    return jobs;
  }

  async deleteJobData(id: string): Promise<void> {
    const job = await this.getJob(id);
    if (!job || !isTerminal(job.state)) return;
    await this.redis.del(this.jobKey(id), this.k(`job:${id}:logs`), this.k(`job:${id}:seq`));
    await this.redis.srem(this.k(`user:${job.ownerId}:jobs`), id);
    await this.redis.srem(this.k(`ws:${job.workspaceId}:jobs`), id);
    await this.redis.srem(this.k('active'), id);
  }

  private async publish(event: JobEvent): Promise<void> {
    await this.redis.publish(this.k('events'), JSON.stringify(event));
  }
}
