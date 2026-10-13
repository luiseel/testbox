import { createId, queueKeyFor, type JobRecord } from '../src';
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
    ownerId: 'usr_test',
    command: 'true',
    profile,
    resources: 'light',
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

async function openStore(): Promise<{ store: JobStore; close: () => Promise<void> }> {
  const prefix = `store_${Math.random().toString(16).slice(2)}`;
  const client = new IORedis('redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
  return {
    store: new JobStore(client, prefix),
    close: async () => {
      await client.quit();
    },
  };
}
