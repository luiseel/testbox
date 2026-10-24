import { describe, expect, it } from 'vitest';
import {
  chooseSyncTarget,
  chooseWorker,
  explainUnsatisfiable,
  labelsSatisfy,
  rankQueuedJobs,
  toPlacementWorkers,
  workerCanRun,
  workerIsHealthy,
  type PlacementWorker,
} from '../src/schedule';
import type { JobRecord, WorkerRecord } from '../src/types';

const now = 1_000_000;
const ttl = 15_000;

function worker(patch: Partial<PlacementWorker> & Pick<PlacementWorker, 'id' | 'labels'>): PlacementWorker {
  return {
    capacity: 1,
    lastSeen: now,
    active: 0,
    waiting: 0,
    lastJobAt: 0,
    sshHost: null,
    ...patch,
  };
}

describe('scheduler', () => {
  it('matches required labels and rejects a fleet that can never run the job', () => {
    expect(labelsSatisfy(['linux', 'x64', 'node'], [])).toBe(true);
    expect(labelsSatisfy(['linux', 'x64'], ['macos', 'xcode'])).toBe(false);
    const linux = { id: 'linux-1', labels: ['linux', 'x64', 'node'] };
    const mac = { id: 'mac-1', labels: ['macos', 'arm64', 'xcode', 'xcode-16.2', 'ios-simulator'] };
    expect(explainUnsatisfiable(['macos', 'xcode'], [linux])).toContain('macos, xcode');
    expect(explainUnsatisfiable(['macos', 'xcode'], [linux])).toContain('linux-1');
    expect(explainUnsatisfiable(['macos', 'xcode'], [linux, mac])).toBeNull();
    expect(explainUnsatisfiable([], [])).toContain('no workers are registered');
  });

  it('routes to a worker that satisfies labels and prefers workspace affinity', () => {
    const linux = worker({ id: 'linux-1', labels: ['linux', 'x64'] });
    const mac = worker({ id: 'mac-1', labels: ['macos', 'arm64', 'xcode'] });
    const ios = { requires: ['macos', 'xcode'] };
    expect(chooseWorker(ios, [linux, mac], null, now, ttl)?.id).toBe('mac-1');
    expect(chooseWorker({ requires: ['linux'] }, [linux, mac], null, now, ttl)?.id).toBe('linux-1');

    const a = worker({ id: 'a', labels: ['linux'], sshHost: 'testbox@a' });
    const b = worker({ id: 'b', labels: ['linux'], sshHost: 'testbox@b' });
    const unit = { requires: [] as string[] };
    expect(chooseWorker(unit, [b, a], null, now, ttl)?.id).toBe('a');
    expect(chooseWorker(unit, [a, b], 'b', now, ttl)?.id).toBe('b');
    expect(chooseSyncTarget(unit, [a, b], 'b', now, ttl)?.id).toBe('b');
  });

  it('skips workers that are full, stale, or not the pinned worker', () => {
    const warm = worker({ id: 'warm', labels: ['linux'], capacity: 2, active: 2 });
    const cold = worker({ id: 'cold', labels: ['linux'], capacity: 2, active: 0 });
    const unit = { requires: [] as string[] };
    expect(chooseWorker(unit, [warm, cold], 'warm', now, ttl)?.id).toBe('cold');

    const busy = worker({ id: 'busy', labels: ['linux'], active: 1, capacity: 2 });
    const idle = worker({ id: 'idle', labels: ['linux'], active: 0 });
    expect(workerCanRun(worker({ id: 'stale', labels: ['linux'], lastSeen: now - ttl - 1 }), unit, now, ttl)).toBe(
      false,
    );
    expect(workerCanRun(idle, { ...unit, targetWorkerId: 'busy' }, now, ttl)).toBe(false);
    expect(workerCanRun(busy, { ...unit, targetWorkerId: 'busy' }, now, ttl)).toBe(true);
  });

  it('gives equal workers turns: the one that waited longest wins', () => {
    const unit = { requires: ['mise'] };
    const a = worker({ id: 'a', labels: ['mise'], lastJobAt: 200 });
    const b = worker({ id: 'b', labels: ['mise'], lastJobAt: 100 });
    const c = worker({ id: 'c', labels: ['mise'], lastJobAt: 300 });
    expect(chooseWorker(unit, [a, b, c], null, now, ttl)?.id).toBe('b');
    expect(chooseSyncTarget(unit, [a, b, c], null, now, ttl)?.id).toBe('b');
  });

  it('syncs to the least-loaded worker when the warm worker is full; the warm worker wins a tie', () => {
    const unit = { requires: [] as string[] };
    const warm = worker({ id: 'warm', labels: [], active: 1 });
    const cold = worker({ id: 'cold', labels: [] });
    expect(chooseSyncTarget(unit, [warm, cold], 'warm', now, ttl)?.id).toBe('cold');
    const busy = worker({ id: 'busy', labels: [], active: 1 });
    expect(chooseSyncTarget(unit, [busy, warm], 'warm', now, ttl)?.id).toBe('warm');
    const backlog = worker({ id: 'backlog', labels: [], active: 1, waiting: 2 });
    expect(chooseSyncTarget(unit, [backlog, busy], 'backlog', now, ttl)?.id).toBe('busy');
  });

  it('counts queued jobs pinned to a worker as its load', () => {
    const unit = { requires: [] as string[] };
    const pinned = worker({ id: 'a', labels: [], waiting: 1 });
    const free = worker({ id: 'b', labels: [], lastJobAt: 500 });
    expect(chooseSyncTarget(unit, [pinned, free], null, now, ttl)?.id).toBe('b');
    expect(chooseSyncTarget(unit, [pinned, free], 'a', now, ttl)?.id).toBe('b');
    expect(workerCanRun(pinned, { ...unit, targetWorkerId: 'a' }, now, ttl)).toBe(true);
  });

  it('orders queued jobs by priority then fifo', () => {
    const ranked = rankQueuedJobs([
      { id: 'low', priority: 0, createdAt: 1 },
      { id: 'high-late', priority: 10, createdAt: 3 },
      { id: 'low-late', priority: 0, createdAt: 2 },
      { id: 'high-early', priority: 10, createdAt: 2 },
    ]);
    expect(ranked.map((job) => job.id)).toEqual(['high-early', 'high-late', 'low', 'low-late']);
  });

  it('counts active and pinned queued jobs, keeps the last job time, and gives a capacity of 0 one slot', () => {
    const records: WorkerRecord[] = [
      {
        id: 'w1',
        hostname: 'h1',
        os: 'linux',
        arch: 'x64',
        labels: ['linux'],
        capacity: 3,
        lastSeen: now,
        sshHost: 'testbox@h1',
      },
      { id: 'w2', hostname: 'h2', os: 'linux', arch: 'x64', labels: [], capacity: 0, lastSeen: now - 5, sshHost: null },
    ];
    const jobs = [
      { workerId: 'w1', state: 'assigned', assignedAt: 30 },
      { workerId: 'w1', state: 'running', assignedAt: 20 },
      { workerId: 'w1', state: 'succeeded', assignedAt: 10, endedAt: 40 },
      { workerId: null, state: 'queued', targetWorkerId: 'w1' },
      { workerId: null, state: 'queued', targetWorkerId: null },
      { workerId: 'w2', state: 'cancelled' },
    ] as JobRecord[];
    expect(toPlacementWorkers(records, jobs)).toEqual([
      {
        id: 'w1',
        labels: ['linux'],
        capacity: 3,
        lastSeen: now,
        active: 2,
        waiting: 1,
        lastJobAt: 40,
        sshHost: 'testbox@h1',
      },
      { id: 'w2', labels: [], capacity: 1, lastSeen: now - 5, active: 0, waiting: 0, lastJobAt: 0, sshHost: null },
    ]);
  });

  it('treats a worker seen exactly one heartbeat ttl ago as healthy', () => {
    expect(workerIsHealthy(worker({ id: 'a', labels: [], lastSeen: now - ttl }), now, ttl)).toBe(true);
    expect(workerIsHealthy(worker({ id: 'a', labels: [], lastSeen: now - ttl - 1 }), now, ttl)).toBe(false);
  });

  it('does not sync to a stale worker, even the affinity worker', () => {
    const stale = worker({ id: 'stale', labels: ['linux'], lastSeen: now - ttl - 1 });
    const unit = { requires: [] as string[] };
    expect(chooseSyncTarget(unit, [stale], 'stale', now, ttl)).toBeNull();
    const full = worker({ id: 'full', labels: ['linux'], active: 1, capacity: 1 });
    expect(chooseSyncTarget(unit, [stale, full], 'stale', now, ttl)?.id).toBe('full');
    expect(chooseSyncTarget({ requires: ['macos'] }, [full], null, now, ttl)).toBeNull();
  });
});
