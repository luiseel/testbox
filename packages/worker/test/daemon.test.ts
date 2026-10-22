import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId, directoryDigest, isTerminal, queueKeyFor, type JobRecord } from '@testbox/shared';
import { startDaemon, type Daemon, type DaemonOptions } from '../src/daemon';

const redisUrl = process.env.TESTBOX_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const OWNER_ID = 'usr_daemon';

describe('daemon', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of open.splice(0)) await close();
  });

  async function boot(opts: Partial<DaemonOptions> = {}): Promise<Ctx> {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tb-daemon-'));
    const prefix = `daemon_${Math.random().toString(16).slice(2)}`;
    const daemon = await startDaemon({
      redisUrl,
      keyPrefix: prefix,
      dataDir,
      workerId: `worker-${prefix}`,
      labels: ['linux', 'node'],
      heartbeatMs: 200,
      graceMs: 200,
      processImmediately: false,
      install: async () => 0,
      ...opts,
    });
    // The claim loop finds jobs through their owner.
    await daemon.store.createUser({ id: OWNER_ID, name: 'owner', role: 'user', createdAt: Date.now() });
    open.push(async () => {
      await daemon.stop();
      await rm(dataDir, { recursive: true, force: true });
    });
    return { daemon, dataDir, prefix };
  }

  it.each([
    { command: 'exit 0', state: 'succeeded', exitCode: 0, error: null },
    { command: 'exit 3', state: 'failed', exitCode: 3, error: 'exit 3' },
    { command: 'sleep 10', timeoutMs: 300, state: 'timed_out', error: 'timeout' },
  ])('ends `$command` as $state', async ({ command, timeoutMs, state, exitCode, error }) => {
    const ctx = await boot();
    const job = await queueJob(ctx, { command, timeoutMs });
    await ctx.daemon.startProcessing();
    const ended = await waitTerminal(ctx, job.id);
    expect(ended.state).toBe(state);
    expect(ended.error).toBe(error);
    if (exitCode !== undefined) expect(ended.exitCode).toBe(exitCode);
  });

  it('ends a running job as cancelled when a cancel is requested', async () => {
    const ctx = await boot();
    const job = await queueJob(ctx, { command: 'sleep 10' });
    await ctx.daemon.startProcessing();
    await waitFor(async () => (await ctx.daemon.store.getJob(job.id))?.state === 'running');
    await ctx.daemon.store.requestCancel(job.id);
    const ended = await waitTerminal(ctx, job.id);
    expect(ended.state).toBe('cancelled');
    expect(ended.error).toBe('cancelled');
  });

  it('writes every log line before the terminal state, even when the store is slow', async () => {
    const ctx = await boot();
    const appendLog = ctx.daemon.store.appendLog.bind(ctx.daemon.store);
    vi.spyOn(ctx.daemon.store, 'appendLog').mockImplementation(async (...args) => {
      await delay(150);
      return appendLog(...args);
    });
    const job = await queueJob(ctx, { command: 'for i in $(seq 1 20); do echo line$i; done' });
    await ctx.daemon.handleJob(job.id);
    expect((await ctx.daemon.store.getJob(job.id))?.state).toBe('succeeded');
    const lines = (await ctx.daemon.store.readLogs(job.id, 0)).map((log) => log.line);
    expect(lines.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `line${i + 1}`).sort());
  });

  it('renews the lease while the job runs and stops renewing when it ends', async () => {
    const leaseMs = 300;
    const ctx = await boot({ leaseMs });
    const renewLease = vi.spyOn(ctx.daemon.store, 'renewLease');
    const job = await queueJob(ctx, { command: 'sleep 1.2' });
    const run = ctx.daemon.handleJob(job.id);
    await waitFor(async () => (await ctx.daemon.store.getJob(job.id))?.state === 'running');
    await delay(leaseMs * 2);
    const running = await ctx.daemon.store.getJob(job.id);
    expect(running?.state).toBe('running');
    expect(running?.leaseExpiresAt).toBeGreaterThan(Date.now());
    await run;
    expect((await ctx.daemon.store.getJob(job.id))?.state).toBe('succeeded');
    const calls = renewLease.mock.calls.length;
    await delay(leaseMs);
    expect(renewLease.mock.calls.length).toBe(calls);
  });

  describe('a claimed job that cannot start fails without running its command', () => {
    it('when the snapshot changed after submission', async () => {
      const ctx = await boot();
      const job = await queueJob(ctx, { command: 'touch ran.marker' });
      await writeFile(path.join(ctx.dataDir, job.snapshotRelPath, 'keep.txt'), 'changed\n');
      await ctx.daemon.startProcessing();
      const ended = await waitTerminal(ctx, job.id);
      expect(ended.state).toBe('failed');
      expect(ended.error).toBe('snapshot digest mismatch');
      expect(await exists(path.join(ctx.dataDir, job.snapshotRelPath, 'ran.marker'))).toBe(false);
    });

    it('when the dependency install fails', async () => {
      const ctx = await boot({ install: async () => 7 });
      const job = await queueJob(ctx, {
        command: 'touch ran.marker',
        files: { 'package.json': '{}\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
      });
      await ctx.daemon.startProcessing();
      const ended = await waitTerminal(ctx, job.id);
      expect(ended.state).toBe('failed');
      expect(ended.error).toBe('dependency install failed with exit 7');
      expect(await exists(path.join(ctx.dataDir, job.snapshotRelPath, 'ran.marker'))).toBe(false);
    });

    it('when mise install fails', async () => {
      const ctx = await boot({ labels: ['linux', 'node', 'mise'], env: await fakeMiseEnv(5) });
      const job = await queueJob(ctx, { command: 'touch ran.marker', files: { 'mise.toml': '[tools]\n' } });
      await ctx.daemon.startProcessing();
      const ended = await waitTerminal(ctx, job.id);
      expect(ended.state).toBe('failed');
      expect(ended.error).toBe('mise install failed with exit 5');
      expect(await exists(path.join(ctx.dataDir, job.snapshotRelPath, 'ran.marker'))).toBe(false);
    });

    it('ends a job cancelled before it started as cancelled', async () => {
      const ctx = await boot();
      const job = await queueJob(ctx, { command: 'touch ran.marker', cancelRequested: true });
      await ctx.daemon.startProcessing();
      const ended = await waitTerminal(ctx, job.id);
      expect(ended.state).toBe('cancelled');
      expect(await exists(path.join(ctx.dataDir, job.snapshotRelPath, 'ran.marker'))).toBe(false);
    });
  });
});

interface Ctx {
  daemon: Daemon;
  dataDir: string;
  prefix: string;
}

/** Writes a snapshot under the data dir and queues a job for it. */
async function queueJob(
  ctx: Ctx,
  opts: { command: string; timeoutMs?: number; cancelRequested?: boolean; files?: Record<string, string> },
): Promise<JobRecord> {
  const id = createId('job');
  const snapshotId = createId('snap');
  const snapshotRelPath = `snapshots/${snapshotId}`;
  const dir = path.join(ctx.dataDir, snapshotRelPath);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'keep.txt'), 'keep\n');
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    await writeFile(path.join(dir, name), text);
  }
  const workspaceId = createId('ws');
  const record: JobRecord = {
    id,
    workspaceId,
    snapshotId,
    snapshotRelPath,
    snapshotDigest: await directoryDigest(dir),
    snapshotWorkDir: null,
    ownerId: OWNER_ID,
    command: opts.command,
    profile: 'unit',
    artifactGlobs: [],
    requires: [],
    priority: 0,
    timeoutMs: opts.timeoutMs ?? 20_000,
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
    cancelRequested: opts.cancelRequested ?? false,
    leaseExpiresAt: null,
    pgid: null,
    retentionUntil: Date.now() + 60_000,
    queueKey: queueKeyFor(ctx.prefix, workspaceId, 'unit'),
  };
  await ctx.daemon.store.createJob(record);
  return record;
}

async function waitTerminal(ctx: Ctx, id: string): Promise<JobRecord> {
  let job: JobRecord | null = null;
  await waitFor(async () => {
    job = await ctx.daemon.store.getJob(id);
    return job !== null && isTerminal(job.state);
  });
  return job as unknown as JobRecord;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('timed out waiting');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Worker env with a fake `mise` first on PATH whose `install` exits with `installExit`. */
async function fakeMiseEnv(installExit: number): Promise<NodeJS.ProcessEnv> {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'tb-mise-'));
  const script = [
    '#!/usr/bin/env bash',
    `[ "$1" = install ] && exit ${installExit}`,
    '[ "$1" = exec ] && { shift; [ "$1" = -- ] && shift; exec "$@"; }',
    'exit 2',
    '',
  ].join('\n');
  await writeFile(path.join(bin, 'mise'), script);
  await chmod(path.join(bin, 'mise'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
}
