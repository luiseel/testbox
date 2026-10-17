import { describe, expect, it } from 'vitest';
import {
  chooseSyncTarget,
  chooseWorker,
  explainUnsatisfiable,
  labelsSatisfy,
  rankQueuedJobs,
  workerCanRun,
  type PlacementWorker,
} from '../src/schedule';

const now = 1_000_000;
const ttl = 15_000;

function worker(patch: Partial<PlacementWorker> & Pick<PlacementWorker, 'id' | 'labels'>): PlacementWorker {
  return {
    capacity: 1,
    lastSeen: now,
    active: 0,
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
    expect(workerCanRun(worker({ id: 'stale', labels: ['linux'], lastSeen: now - ttl - 1 }), unit, now, ttl)).toBe(false);
    expect(workerCanRun(idle, { ...unit, targetWorkerId: 'busy' }, now, ttl)).toBe(false);
    expect(workerCanRun(busy, { ...unit, targetWorkerId: 'busy' }, now, ttl)).toBe(true);
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
});
