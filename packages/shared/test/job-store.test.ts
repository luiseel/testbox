import { claimNextJob, createId, queueKeyFor, type JobRecord, type WorkerRecord } from '../src';
import { JobStore } from '../src/job-store';
import IORedis from 'ioredis';
import { describe, expect, it } from 'vitest';

describe('job store', () => {
  it('never moves a terminal job back into a runnable state', async () => {
    const { store, close } = await openStore();
    try {
      const record = baseJob(store.prefix);
      await store.createJob(record);
      expect((await store.transition(record.id, ['queued'], 'assigned', { workerId: 'w' })).ok).toBe(true);
      expect((await store.transition(record.id, ['assigned'], 'running')).ok).toBe(true);
      expect((await store.transition(record.id, ['running'], 'succeeded', { exitCode: 0, endedAt: Date.now() })).ok).toBe(true);
      const again = await store.transition(record.id, ['succeeded', 'queued', 'running'], 'running');
      expect(again.ok).toBe(false);
      expect(again.reason).toBe('terminal');
      expect((await store.getJob(record.id))?.state).toBe('succeeded');
    } finally {
      await close();
    }
  });

  it('supersedes older queued jobs for the same workspace and profile', async () => {
    const { store, close } = await openStore();
    try {
      const first = baseJob(store.prefix, { command: 'echo old' });
      const second = baseJob(store.prefix, { command: 'echo new', id: createId('job') });
      await store.createJob(first);
      const created = await store.createJob(second);
      expect(created.superseded).toEqual([first.id]);
      expect((await store.getJob(first.id))?.state).toBe('cancelled');
      expect((await store.getJob(first.id))?.error).toBe('superseded');
      expect((await store.getJob(second.id))?.state).toBe('queued');
    } finally {
      await close();
    }
  });

  it('keeps the job source and reads a record stored without it as null', async () => {
    const { store, client, close } = await openStore();
    try {
      const source = { path: '/Users/ana/code/app', branch: 'TGN-811', commit: '3edf65d', dirty: true };
      const record = baseJob(store.prefix, { source });
      await store.createJob(record);
      expect((await store.getJob(record.id))?.source).toEqual(source);
      await client.hdel(store.k(`job:${record.id}`), 'source');
      expect((await store.getJob(record.id))?.source).toBeNull();
    } finally {
      await close();
    }
  });

  it('times out a lease and does not renew a finished job', async () => {
    const { store, close } = await openStore();
    try {
      const record = baseJob(store.prefix);
      await store.createJob(record);
      await store.transition(record.id, ['queued'], 'assigned', {
        workerId: 'w1',
        leaseExpiresAt: Date.now() - 10,
      });
      await store.transition(record.id, ['assigned'], 'running');
      const expired = await store.expireLeases(Date.now());
      expect(expired).toEqual([record.id]);
      expect((await store.getJob(record.id))?.state).toBe('timed_out');
      const renewed = await store.renewLease(record.id, 'w1', Date.now() + 1000);
      expect(renewed.ok).toBe(false);
      expect((await store.getJob(record.id))?.state).toBe('timed_out');
    } finally {
      await close();
    }
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('never moves a %s job back to running', async (end) => {
    const { store, close } = await openStore();
    try {
      const record = baseJob(store.prefix);
      await store.createJob(record);
      await store.transition(record.id, ['queued'], 'assigned', { workerId: 'w1' });
      await store.transition(record.id, ['assigned'], 'running');
      expect((await store.transition(record.id, ['running'], end)).ok).toBe(true);
      expect(await store.transition(record.id, [end], 'running')).toEqual({ ok: false, reason: 'terminal' });
      expect((await store.getJob(record.id))?.state).toBe(end);
    } finally {
      await close();
    }
  });

  it('never moves a timed out job back to running', async () => {
    const { store, close } = await openStore();
    try {
      const record = baseJob(store.prefix);
      await store.createJob(record);
      await store.transition(record.id, ['queued'], 'assigned', { workerId: 'w1', leaseExpiresAt: 1000 });
      expect(await store.expireLeases(1000)).toEqual([record.id]);
      expect(await store.transition(record.id, ['timed_out'], 'running')).toEqual({ ok: false, reason: 'terminal' });
      expect((await store.getJob(record.id))?.state).toBe('timed_out');
    } finally {
      await close();
    }
  });

  it('renews a lease only for the worker that owns the job', async () => {
    const { store, close } = await openStore();
    try {
      const record = baseJob(store.prefix);
      await store.createJob(record);
      await store.transition(record.id, ['queued'], 'assigned', { workerId: 'w1', leaseExpiresAt: 1000 });
      await store.transition(record.id, ['assigned'], 'running');
      expect(await store.renewLease(record.id, 'other-worker', 9000)).toEqual({ ok: false, state: 'running' });
      expect((await store.getJob(record.id))?.leaseExpiresAt).toBe(1000);
      expect(await store.renewLease(record.id, 'w1', 9000)).toEqual({ ok: true, state: 'running' });
      expect((await store.getJob(record.id))?.leaseExpiresAt).toBe(9000);
    } finally {
      await close();
    }
  });

  it('expires a lease at its exact end time, not before', async () => {
    const { store, close } = await openStore();
    try {
      const record = baseJob(store.prefix);
      await store.createJob(record);
      await store.transition(record.id, ['queued'], 'assigned', { workerId: 'w1', leaseExpiresAt: 5000 });
      expect(await store.expireLeases(4999)).toEqual([]);
      expect(await store.expireLeases(5000)).toEqual([record.id]);
      const job = await store.getJob(record.id);
      expect(job).toMatchObject({ state: 'timed_out', error: 'lease_expired', endedAt: 5000 });
    } finally {
      await close();
    }
  });

  it('removes a job from its queue when it is assigned and from the active set when it ends', async () => {
    const { store, client, close } = await openStore();
    try {
      const record = baseJob(store.prefix);
      await store.createJob(record);
      expect(await client.smembers(record.queueKey)).toEqual([record.id]);
      expect(await store.listActiveJobs()).toEqual([]);
      await store.transition(record.id, ['queued'], 'assigned', { workerId: 'w1' });
      expect(await client.smembers(record.queueKey)).toEqual([]);
      expect((await store.listActiveJobs()).map((job) => job.id)).toEqual([record.id]);
      await store.transition(record.id, ['assigned'], 'running');
      expect((await store.listActiveJobs()).map((job) => job.id)).toEqual([record.id]);
      await store.transition(record.id, ['running'], 'succeeded', { exitCode: 0 });
      expect(await store.listActiveJobs()).toEqual([]);
    } finally {
      await close();
    }
  });

  it('records the pgid of a live job and ignores it for a finished job', async () => {
    const { store, close } = await openStore();
    try {
      const live = baseJob(store.prefix);
      await store.createJob(live);
      await store.transition(live.id, ['queued'], 'assigned', { workerId: 'w1' });
      await store.transition(live.id, ['assigned'], 'running');
      await store.setPgid(live.id, 4242);
      expect((await store.getJob(live.id))?.pgid).toBe(4242);

      const done = baseJob(store.prefix, { profile: null, queueKey: '' });
      await store.createJob(done);
      await store.transition(done.id, ['queued'], 'cancelled');
      await store.setPgid(done.id, 4243);
      expect((await store.getJob(done.id))?.pgid).toBeNull();
    } finally {
      await close();
    }
  });

  it('reads back a cancel request', async () => {
    const { store, close } = await openStore();
    try {
      const record = baseJob(store.prefix);
      await store.createJob(record);
      expect((await store.getJob(record.id))?.cancelRequested).toBe(false);
      await store.requestCancel(record.id);
      expect((await store.getJob(record.id))?.cancelRequested).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('claimNextJob', () => {
  const now = 1_000_000;
  const ttl = 15_000;
  const lease = 30_000;

  async function seed(store: JobStore, workers: Partial<WorkerRecord>[]): Promise<void> {
    await store.createUser({ id: 'usr_test', name: `u_${store.prefix}`, role: 'user', createdAt: now });
    for (const patch of workers) {
      await store.upsertWorker({
        id: 'w1', hostname: 'h', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1, lastSeen: now, sshHost: null,
        ...patch,
      });
    }
  }

  it('assigns the highest priority job, with a lease and workspace affinity', async () => {
    const { store, close } = await openStore();
    try {
      await seed(store, [{ id: 'w1' }]);
      const low = baseJob(store.prefix, { profile: null, queueKey: '', priority: 0, createdAt: now - 10 });
      const high = baseJob(store.prefix, { profile: null, queueKey: '', priority: 5, createdAt: now });
      await store.createJob(low);
      await store.createJob(high);
      const claimed = await claimNextJob(store, 'w1', () => now, ttl, lease);
      expect(claimed).toMatchObject({
        id: high.id,
        state: 'assigned',
        workerId: 'w1',
        assignedAt: now,
        leaseExpiresAt: now + lease,
        attemptId: `attempt_${high.id}`,
      });
      expect(await store.getWorkspaceAffinity(high.workspaceId)).toBe('w1');
      // The one slot is taken now.
      expect(await claimNextJob(store, 'w1', () => now, ttl, lease)).toBeNull();
      expect((await store.getJob(low.id))?.state).toBe('queued');
    } finally {
      await close();
    }
  });

  it('starts the lease at the assignment and holds the lock for all of a slow claim', async () => {
    const { store, client, close } = await openStore();
    try {
      await seed(store, [{ id: 'w1' }]);
      const job = baseJob(store.prefix);
      await store.createJob(job);
      let time = now;
      let lockTtl = 0;
      const readJobs = store.listAllJobs.bind(store);
      store.listAllJobs = async () => {
        const jobs = await readJobs();
        time += 10_000;
        lockTtl = await client.pttl(store.k('lock:scheduler'));
        return jobs;
      };
      const readAffinities = store.getWorkspaceAffinities.bind(store);
      store.getWorkspaceAffinities = async (ids) => {
        const affinities = await readAffinities(ids);
        time += 10_000;
        return affinities;
      };
      const claimed = await claimNextJob(store, 'w1', () => time, ttl, lease);
      expect(claimed).toMatchObject({ assignedAt: now + 20_000, leaseExpiresAt: now + 20_000 + lease });
      expect(lockTtl).toBeGreaterThan(5_000);
    } finally {
      await close();
    }
  });

  it('lists the jobs of every user', async () => {
    const { store, close } = await openStore();
    try {
      const mine = baseJob(store.prefix, { profile: null, queueKey: '' });
      const theirs = baseJob(store.prefix, { profile: null, queueKey: '', ownerId: 'other', id: createId('job') });
      await store.createUser({ id: mine.ownerId, name: mine.ownerId, role: 'user', createdAt: now });
      await store.createUser({ id: 'other', name: 'other', role: 'user', createdAt: now });
      await store.createJob(mine);
      await store.createJob(theirs);
      expect((await store.listAllJobs()).map((job) => job.id).sort()).toEqual([mine.id, theirs.id].sort());
    } finally {
      await close();
    }
  });

  it('gives nothing to a stale, unknown, or unfit worker', async () => {
    const { store, close } = await openStore();
    try {
      await seed(store, [
        { id: 'stale', lastSeen: now - ttl - 1 },
        { id: 'mac', labels: ['macos'] },
      ]);
      const job = baseJob(store.prefix, { requires: ['linux'] });
      await store.createJob(job);
      expect(await claimNextJob(store, 'stale', () => now, ttl, lease)).toBeNull();
      expect(await claimNextJob(store, 'nobody', () => now, ttl, lease)).toBeNull();
      expect(await claimNextJob(store, 'mac', () => now, ttl, lease)).toBeNull();
      expect((await store.getJob(job.id))?.state).toBe('queued');
    } finally {
      await close();
    }
  });

  it('leaves a job for the affinity worker when it has a free slot', async () => {
    const { store, close } = await openStore();
    try {
      await seed(store, [{ id: 'a' }, { id: 'b' }]);
      const job = baseJob(store.prefix);
      await store.createJob(job);
      await store.setWorkspaceAffinity(job.workspaceId, 'b');
      expect(await claimNextJob(store, 'a', () => now, ttl, lease)).toBeNull();
      expect((await claimNextJob(store, 'b', () => now, ttl, lease))?.id).toBe(job.id);
    } finally {
      await close();
    }
  });
});

function baseJob(prefix: string, patch: Partial<JobRecord> = {}): JobRecord {
  const id = patch.id ?? createId('job');
  const profile = 'unit';
  const workspaceId = 'ws_testworkspace000000000000';
  return {
    id,
    workspaceId,
    snapshotId: 'snap_aaaaaaaaaaaaaaaaaaaaaaaa',
    snapshotRelPath: 'snapshots/snap_aaaaaaaaaaaaaaaaaaaaaaaa',
    snapshotDigest: 'ab'.repeat(32),
    snapshotWorkDir: null,
    ownerId: 'usr_test',
    command: 'true',
    profile,
    artifactGlobs: [],
    requires: [],
    priority: 0,
    timeoutMs: 30_000,
    state: 'queued',
    createdAt: Date.now(),
    assignedAt: null,
    startedAt: null,
    endedAt: null,
    workerId: null,
    targetWorkerId: null,
    source: null,
    attemptId: null,
    exitCode: null,
    error: null,
    cancelRequested: false,
    leaseExpiresAt: null,
    pgid: null,
    retentionUntil: Date.now() + 60_000,
    queueKey: queueKeyFor(prefix, workspaceId, profile),
    ...patch,
  };
}

async function openStore(): Promise<{ store: JobStore; client: IORedis; close: () => Promise<void> }> {
  const prefix = `store_${Math.random().toString(16).slice(2)}`;
  const client = new IORedis(process.env.TESTBOX_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
  return {
    store: new JobStore(client, prefix),
    client,
    close: async () => {
      await client.quit();
    },
  };
}
