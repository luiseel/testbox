import type { INestApplication } from '@nestjs/common';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createId, createSnapshot, writeRetention, type JobRecord } from '@testbox/shared';
import { Daemon, startDaemon } from '@testbox/worker';
import { CleanupService } from '../src/cleanup.service';
import { createApp } from '../src/create-app';

const redisUrl = 'redis://127.0.0.1:6379';

describe('queue and execution', () => {
  const open: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    while (open.length) {
      const ctx = open.pop();
      if (ctx) await ctx.close();
    }
  });

  it('rejects missing auth and hides other users workspaces', async () => {
    const ctx = await boot({ withDaemon: false });
    open.push(ctx);
    const anon = await call(ctx, '', 'GET', '/v1/users/me');
    expect(anon.status).toBe(401);
    const alice = await user(ctx, 'alice');
    const bob = await user(ctx, 'bob');
    const ws = await call(ctx, alice.token, 'POST', '/v1/workspaces', { project: 'demo' });
    expect(ws.status).toBe(201);
    const hidden = await call(ctx, bob.token, 'GET', `/v1/workspaces/${ws.json.id}`);
    expect(hidden.status).toBe(404);
    const denied = await call(ctx, '', 'POST', '/v1/jobs', {});
    expect(denied.status).toBe(401);
  });

  it('lets only an admin find a user by name', async () => {
    const ctx = await boot({ withDaemon: false });
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const me = await call(ctx, alice.token, 'GET', '/v1/users/me');
    const found = await call(ctx, ctx.admin, 'GET', `/v1/users?name=${me.json.name as string}`);
    expect(found.status).toBe(200);
    expect(found.json.users).toEqual([{ id: alice.id, name: me.json.name, role: 'user' }]);
    const missing = await call(ctx, ctx.admin, 'GET', '/v1/users?name=nobody');
    expect(missing.json.users).toEqual([]);
    const denied = await call(ctx, alice.token, 'GET', '/v1/users?name=nobody');
    expect(denied.status).toBe(403);
  });

  it('returns no worker when nothing is heartbeating', async () => {
    const ctx = await boot({ withDaemon: false });
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const submitted = await submit(ctx, alice.token, { command: 'true', profile: 'unit' });
    expect(submitted.status).toBe(503);
    expect(submitted.json.error.code).toBe('NO_WORKER');
  });

  it('runs queued jobs in order unless priority or latest-wins applies', async () => {
    const ctx = await boot();
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const order = path.join(ctx.dataDir, 'order.txt');
    const low = await submit(ctx, alice.token, {
      command: `echo A >> ${shellQuote(order)}; sleep 0.4; echo A >> ${shellQuote(order)}`,
      profile: 'alpha',
      priority: 0,
    });
    const high = await submit(ctx, alice.token, {
      command: `echo B >> ${shellQuote(order)}`,
      profile: 'beta',
      priority: 10,
    });
    expect(low.status).toBe(201);
    expect(high.status).toBe(201);
    await ctx.daemon?.startProcessing();
    const highJob = await waitJob(ctx, alice.token, high.json.job.id);
    const lowJob = await waitJob(ctx, alice.token, low.json.job.id);
    expect(highJob.state).toBe('succeeded');
    expect(lowJob.state).toBe('succeeded');
    const text = await readFile(order, 'utf8');
    expect(text).toBe('B\nA\nA\n');
  });

  it('keeps fifo order for equal priority and cancels older queued profiles', async () => {
    const ctx = await boot();
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const order = path.join(ctx.dataDir, 'fifo.txt');
    const first = await submit(ctx, alice.token, {
      command: `echo A >> ${shellQuote(order)}; sleep 0.3; echo A >> ${shellQuote(order)}`,
      profile: 'alpha',
    });
    const second = await submit(ctx, alice.token, {
      command: `echo B >> ${shellQuote(order)}`,
      profile: 'beta',
    });
    const unitWorkspace = await call(ctx, alice.token, 'POST', '/v1/workspaces', { project: 'unitproj' });
    const older = await submit(ctx, alice.token, {
      command: `echo NO >> ${shellQuote(order)}`,
      profile: 'unit',
      workspace: { id: unitWorkspace.json.id as string, stagingRel: unitWorkspace.json.stagingRel as string },
    });
    const newer = await submit(ctx, alice.token, {
      command: `echo YES >> ${shellQuote(order)}`,
      profile: 'unit',
      workspace: { id: unitWorkspace.json.id as string, stagingRel: unitWorkspace.json.stagingRel as string },
    });
    expect(newer.json.superseded).toContain(older.json.job.id);
    const supersededNow = await call(ctx, alice.token, 'GET', `/v1/jobs/${older.json.job.id}`);
    expect(supersededNow.json.job.state).toBe('cancelled');
    expect(supersededNow.json.job.error).toBe('superseded');
    await ctx.daemon?.startProcessing();
    await waitJob(ctx, alice.token, first.json.job.id);
    await waitJob(ctx, alice.token, second.json.job.id);
    await waitJob(ctx, alice.token, newer.json.job.id);
    expect(await readFile(order, 'utf8')).toBe('A\nA\nB\nYES\n');
    const superseded = await call(ctx, alice.token, 'GET', `/v1/jobs/${older.json.job.id}`);
    expect(superseded.json.job.state).toBe('cancelled');
  });

  it('runs the submitted snapshot after the staging tree changes', async () => {
    const ctx = await boot();
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const ws = await call(ctx, alice.token, 'POST', '/v1/workspaces', { project: 'demo' });
    const staging = path.join(ctx.dataDir, ws.json.stagingRel);
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, 'hello.txt'), 'v1\n');
    const snapshotId = createId('snap');
    const snap = await createSnapshot({
      dataDir: ctx.dataDir,
      stagingRel: ws.json.stagingRel,
      snapshotId,
      ignore: ['node_modules', '.git', '.env'],
      retentionMs: 60_000,
    });
    await writeFile(path.join(staging, 'hello.txt'), 'v2\n');
    const registered = await call(ctx, alice.token, 'POST', `/v1/workspaces/${ws.json.id}/snapshots`, {
      id: snapshotId,
      digest: snap.digest,
    });
    expect(registered.status).toBe(201);
    const events = collectSse(ctx, alice.token, '');
    const created = await call(ctx, alice.token, 'POST', '/v1/jobs', {
      workspaceId: ws.json.id,
      snapshotId,
      command: 'cat hello.txt',
      profile: 'cat',
      artifactGlobs: ['hello.txt'],
    });
    const stream = collectSse(ctx, alice.token, created.json.job.id);
    await ctx.daemon?.startProcessing();
    const job = await waitJob(ctx, alice.token, created.json.job.id);
    expect(job.state).toBe('succeeded');
    const sse = await stream;
    expect(sse.logs.join('\n')).toContain('v1');
    expect(sse.logs.join('\n')).not.toContain('v2');
    const artifacts = await call(ctx, alice.token, 'GET', `/v1/jobs/${job.id}/artifacts`);
    expect(artifacts.json.files.map((file: { path: string }) => file.path)).toContain('hello.txt');
    const download = await fetch(
      `${ctx.base}/v1/jobs/${job.id}/artifacts/content?path=${encodeURIComponent('hello.txt')}`,
      { headers: { authorization: `Bearer ${alice.token}` } },
    );
    expect(await download.text()).toBe('v1\n');
    expect(events).toBeDefined();
  });

  it('fails a job whose snapshot changed after submission and does not run it', async () => {
    const ctx = await boot();
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const marker = path.join(ctx.dataDir, 'should-not-run.txt');
    const created = await submit(ctx, alice.token, {
      command: `echo RAN > ${shellQuote(marker)}`,
      profile: 'guard',
      mutateSnapshot: true,
    });
    await ctx.daemon?.startProcessing();
    const job = await waitJob(ctx, alice.token, created.json.job.id);
    expect(job.state).toBe('failed');
    expect(job.error).toContain('snapshot digest mismatch');
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('cancels a running job by killing its process tree and then accepts another job', async () => {
    const ctx = await boot();
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const marker = path.join(ctx.dataDir, 'cancel.txt');
    const created = await submit(ctx, alice.token, {
      command: `echo ran > ${shellQuote(marker)}; sleep 30`,
      profile: 'slow',
    });
    await ctx.daemon?.startProcessing();
    await waitFor(async () => {
      const job = await call(ctx, alice.token, 'GET', `/v1/jobs/${created.json.job.id}`);
      return job.json.job?.state === 'running' && Boolean(await readFile(marker, 'utf8').catch(() => ''));
    });
    const running = await call(ctx, alice.token, 'GET', `/v1/jobs/${created.json.job.id}`);
    const pgid = running.json.job.pgid as number;
    expect(pgid).toBeGreaterThan(1);
    const cancelled = await call(ctx, alice.token, 'POST', `/v1/jobs/${created.json.job.id}/cancel`);
    expect(cancelled.status).toBe(201);
    const finished = await waitJob(ctx, alice.token, created.json.job.id);
    expect(finished.state).toBe('cancelled');
    await waitFor(() => !alive(pgid));
    const next = await submit(ctx, alice.token, { command: 'true', profile: 'after' });
    const nextJob = await waitJob(ctx, alice.token, next.json.job.id);
    expect(nextJob.state).toBe('succeeded');
  });

  it('times out a lost worker lease and does not run the command again', async () => {
    const ctx = await boot({ leaseMs: 700, sweeperMs: 100 });
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const marker = path.join(ctx.dataDir, 'loss.txt');
    const created = await submit(ctx, alice.token, {
      command: `echo RAN >> ${shellQuote(marker)}; sleep 30`,
      profile: 'loss',
    });
    await ctx.daemon?.startProcessing();
    await waitFor(async () => (await readFile(marker, 'utf8').catch(() => '')).includes('RAN'));
    ctx.daemon?.simulateCrash();
    const timedOut = await waitJob(ctx, alice.token, created.json.job.id);
    expect(timedOut.state).toBe('timed_out');
    expect(timedOut.error).toBe('lease_expired');
    const pgid = timedOut.pgid as number;
    await ctx.daemon?.reapOrphans();
    if (pgid) await waitFor(() => !alive(pgid));
    await ctx.daemon?.handleJob(created.json.job.id);
    expect(await readFile(marker, 'utf8')).toBe('RAN\n');
    const after = await call(ctx, alice.token, 'GET', `/v1/jobs/${created.json.job.id}`);
    expect(after.json.job.state).toBe('timed_out');
  });

  it('cleans expired data without touching cache', async () => {
    const ctx = await boot();
    open.push(ctx);
    await mkdir(path.join(ctx.dataDir, 'cache'), { recursive: true });
    await writeFile(path.join(ctx.dataDir, 'cache', 'warm.txt'), 'keep');
    await mkdir(path.join(ctx.dataDir, 'artifacts', 'job_aaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
    await writeFile(path.join(ctx.dataDir, 'artifacts', 'job_aaaaaaaaaaaaaaaaaaaaaaaa', 'x.txt'), 'gone');
    await writeRetention(ctx.dataDir, 'artifacts', 'job_aaaaaaaaaaaaaaaaaaaaaaaa', Date.now() - 5);
    const cleanup = ctx.app.get(CleanupService);
    await cleanup.runOnce();
    expect(await readFile(path.join(ctx.dataDir, 'cache', 'warm.txt'), 'utf8')).toBe('keep');
    await expect(readFile(path.join(ctx.dataDir, 'artifacts', 'job_aaaaaaaaaaaaaaaaaaaaaaaa', 'x.txt'), 'utf8')).rejects.toThrow();
  });

  it('routes a job only to a worker whose labels satisfy the profile', async () => {
    const ctx = await boot({ workerId: 'linux-1', labels: ['linux', 'x64', 'node'] });
    open.push(ctx);
    const mac = await extraDaemon(ctx, {
      workerId: 'mac-1',
      labels: ['macos', 'arm64', 'xcode', 'xcode-16.2', 'ios-simulator'],
    });
    const alice = await user(ctx, 'alice');
    const ios = await submit(ctx, alice.token, {
      command: 'true',
      profile: 'ios',
      requires: ['macos', 'xcode'],
    });
    const unit = await submit(ctx, alice.token, {
      command: 'true',
      profile: 'unit',
      requires: ['linux'],
    });
    expect(ios.status).toBe(201);
    expect(unit.status).toBe(201);
    await ctx.daemon?.startProcessing();
    await mac.startProcessing();
    const iosJob = await waitJob(ctx, alice.token, ios.json.job.id as string);
    const unitJob = await waitJob(ctx, alice.token, unit.json.job.id as string);
    expect(iosJob.state).toBe('succeeded');
    expect(iosJob.workerId).toBe('mac-1');
    expect(unitJob.state).toBe('succeeded');
    expect(unitJob.workerId).toBe('linux-1');
  });

  it('installs mise tools and runs the command under mise exec when the snapshot has mise.toml', async () => {
    const ctx = await boot({ labels: ['linux', 'node', 'mise'], env: await fakeMiseEnv(0) });
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const job = await submit(ctx, alice.token, {
      command: [
        'test -f installed.marker',
        'test "$FAKE_MISE_EXEC" = 1',
        'test "$MISE_YES" = 1',
        `test "$MISE_TRUSTED_CONFIG_PATHS" = ${shellQuote(ctx.dataDir)}`,
      ].join(' && '),
      requires: ['mise'],
      files: { 'mise.toml': '[tools]\njava = "temurin-25"\n' },
    });
    expect(job.status).toBe(201);
    await ctx.daemon?.startProcessing();
    const done = await waitJob(ctx, alice.token, job.json.job.id as string);
    expect(done.state).toBe('succeeded');
  });

  it('fails the job without running the command when mise install fails', async () => {
    const ctx = await boot({ labels: ['linux', 'node', 'mise'], env: await fakeMiseEnv(3) });
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const marker = path.join(ctx.dataDir, 'ran.txt');
    const job = await submit(ctx, alice.token, {
      command: `echo RAN > ${shellQuote(marker)}`,
      files: { '.tool-versions': 'java temurin-25\n' },
    });
    await ctx.daemon?.startProcessing();
    const done = await waitJob(ctx, alice.token, job.json.job.id as string);
    expect(done.state).toBe('failed');
    expect(done.error).toBe('mise install failed with exit 3');
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('runs with worker tools when the snapshot has mise.toml but the worker has no mise', async () => {
    const ctx = await boot({ labels: ['linux', 'node'], env: await fakeMiseEnv(0) });
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const job = await submit(ctx, alice.token, {
      command: 'test ! -f installed.marker && test -z "$FAKE_MISE_EXEC"',
      files: { 'mise.toml': '[tools]\n' },
    });
    await ctx.daemon?.startProcessing();
    const done = await waitJob(ctx, alice.token, job.json.job.id as string);
    expect(done.state).toBe('succeeded');
  });

  it('rejects a job when no registered worker can ever satisfy its labels', async () => {
    const ctx = await boot({ workerId: 'linux-1', labels: ['linux', 'x64', 'node'] });
    open.push(ctx);
    const alice = await user(ctx, 'alice');
    const submitted = await submit(ctx, alice.token, {
      command: 'true',
      profile: 'ios',
      requires: ['macos', 'xcode'],
    });
    expect(submitted.status).toBe(503);
    expect(submitted.json.error.code).toBe('NO_WORKER');
    const message = String(submitted.json.error.message);
    expect(message).toContain('no registered worker can satisfy required labels: macos, xcode');
    expect(message).toContain('linux-1');
  });

  it('prefers the worker that already ran the workspace when both are free', async () => {
    const ctx = await boot({ workerId: 'warm', labels: ['linux', 'node', 'warm-cache'] });
    open.push(ctx);
    const cold = await extraDaemon(ctx, { workerId: 'cold', labels: ['linux', 'node'] });
    const alice = await user(ctx, 'alice');
    const ws = await call(ctx, alice.token, 'POST', '/v1/workspaces', { project: 'affinity' });
    const workspace = { id: ws.json.id as string, stagingRel: ws.json.stagingRel as string };
    await ctx.daemon?.startProcessing();
    await cold.startProcessing();
    const first = await submit(ctx, alice.token, {
      command: 'true',
      profile: 'unit',
      requires: ['warm-cache'],
      workspace,
    });
    const firstJob = await waitJob(ctx, alice.token, first.json.job.id as string);
    const second = await submit(ctx, alice.token, {
      command: 'true',
      profile: 'again',
      requires: ['linux'],
      workspace,
    });
    const secondJob = await waitJob(ctx, alice.token, second.json.job.id as string);
    expect(firstJob.workerId).toBe('warm');
    expect(secondJob.state).toBe('succeeded');
    expect(secondJob.workerId).toBe('warm');
  });

  it('does not rerun a job after its worker is lost while another worker is healthy', async () => {
    const ctx = await boot({
      leaseMs: 700,
      sweeperMs: 100,
      workerId: 'worker-a',
      labels: ['linux', 'pool-a'],
    });
    open.push(ctx);
    const other = await extraDaemon(ctx, {
      workerId: 'worker-b',
      labels: ['linux', 'pool-b'],
      leaseMs: 700,
    });
    const alice = await user(ctx, 'alice');
    const marker = path.join(ctx.dataDir, 'loss-multi.txt');
    const created = await submit(ctx, alice.token, {
      command: `echo RAN >> ${shellQuote(marker)}; sleep 30`,
      profile: 'loss',
      requires: ['pool-a'],
    });
    await ctx.daemon?.startProcessing();
    await other.startProcessing();
    await waitFor(async () => (await readFile(marker, 'utf8').catch(() => '')).includes('RAN'));
    ctx.daemon?.simulateCrash();
    const timedOut = await waitJob(ctx, alice.token, created.json.job.id as string);
    expect(timedOut.state).toBe('timed_out');
    expect(timedOut.error).toBe('lease_expired');
    expect(timedOut.workerId).toBe('worker-a');
    const pgid = timedOut.pgid as number;
    await ctx.daemon?.reapOrphans();
    if (pgid) await waitFor(() => !alive(pgid));
    const next = await submit(ctx, alice.token, { command: 'true', profile: 'after', requires: ['pool-b'] });
    const nextJob = await waitJob(ctx, alice.token, next.json.job.id as string);
    expect(nextJob.state).toBe('succeeded');
    expect(nextJob.workerId).toBe('worker-b');
    expect(await readFile(marker, 'utf8')).toBe('RAN\n');
  });
});

interface Ctx {
  app: INestApplication;
  base: string;
  dataDir: string;
  prefix: string;
  daemon: Daemon | null;
  admin: string;
  leaseMs: number;
  close: () => Promise<void>;
}

async function boot(opts?: {
  withDaemon?: boolean;
  leaseMs?: number;
  sweeperMs?: number;
  workerId?: string;
  labels?: string[];
  capacity?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<Ctx> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tb-e2e-'));
  const prefix = `e2e_${Math.random().toString(16).slice(2)}`;
  const app = await createApp({
    redisUrl,
    keyPrefix: prefix,
    dataDir,
    bootstrapToken: 'bootstrap-token-admin-123',
    workerToken: 'worker-token-secret-123',
    leaseMs: opts?.leaseMs ?? 15_000,
    heartbeatTtlMs: 15_000,
    sweeperMs: opts?.sweeperMs ?? 200,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const base = `http://127.0.0.1:${address.port}`;
  const daemon =
    opts?.withDaemon === false
      ? null
      : await startDaemon({
          redisUrl,
          keyPrefix: prefix,
          dataDir,
          workerId: opts?.workerId ?? `worker-${prefix}`,
          labels: opts?.labels ?? ['linux', 'node'],
          capacity: opts?.capacity,
          leaseMs: opts?.leaseMs ?? 15_000,
          heartbeatMs: 200,
          graceMs: 200,
          apiUrl: base,
          workerToken: 'worker-token-secret-123',
          processImmediately: false,
          env: opts?.env,
        });
  return {
    app,
    base,
    dataDir,
    prefix,
    daemon,
    leaseMs: opts?.leaseMs ?? 15_000,
    admin: 'bootstrap-token-admin-123',
    close: async () => {
      if (daemon) await daemon.stop();
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function call(ctx: Ctx, token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = (text ? JSON.parse(text) : {}) as Json;
  return { status: response.status, json };
}

type Json = Record<string, Json | string | number | boolean | null | Json[]>;

async function user(ctx: Ctx, name: string): Promise<{ token: string; id: string }> {
  const suffix = Math.random().toString(16).slice(2, 8);
  const created = await call(ctx, ctx.admin, 'POST', '/v1/users', { name: `${name}${suffix}` });
  if (created.status !== 201) throw new Error(JSON.stringify(created.json));
  const token = await call(ctx, ctx.admin, 'POST', `/v1/users/${created.json.id}/tokens`);
  return { token: token.json.token as string, id: created.json.id as string };
}

async function submit(
  ctx: Ctx,
  token: string,
  opts: {
    command: string;
    profile?: string;
    priority?: number;
    requires?: string[];
    mutateSnapshot?: boolean;
    workspace?: { id: string; stagingRel: string };
    files?: Record<string, string>;
  },
) {
  const ws = opts.workspace
    ? { status: 201, json: { id: opts.workspace.id, stagingRel: opts.workspace.stagingRel } }
    : await call(ctx, token, 'POST', '/v1/workspaces', { project: `p${Math.random().toString(16).slice(2, 6)}` });
  if (ws.status !== 201) throw new Error(JSON.stringify(ws.json));
  const staging = path.join(ctx.dataDir, ws.json.stagingRel as string);
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'keep.txt'), 'keep\n');
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    await writeFile(path.join(staging, name), text);
  }
  const snapshotId = createId('snap');
  const snap = await createSnapshot({
    dataDir: ctx.dataDir,
    stagingRel: ws.json.stagingRel as string,
    snapshotId,
    ignore: ['node_modules', '.git', '.env'],
    retentionMs: 60_000,
  });
  if (opts.mutateSnapshot) await writeFile(path.join(ctx.dataDir, snap.relPath, 'keep.txt'), 'changed\n');
  const registered = await call(ctx, token, 'POST', `/v1/workspaces/${ws.json.id}/snapshots`, {
    id: snapshotId,
    digest: snap.digest,
  });
  if (registered.status !== 201) throw new Error(JSON.stringify(registered.json));
  return call(ctx, token, 'POST', '/v1/jobs', {
    workspaceId: ws.json.id,
    snapshotId,
    command: opts.command,
    profile: opts.profile ?? null,
    priority: opts.priority ?? 0,
    requires: opts.requires,
    timeoutMs: 20_000,
  });
}

/**
 * Worker env with a fake `mise` first on PATH. `install` leaves a marker in
 * the snapshot and exits with `installExit`; `exec` runs the rest of argv.
 */
async function fakeMiseEnv(installExit: number): Promise<NodeJS.ProcessEnv> {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'tb-mise-'));
  const script = [
    '#!/usr/bin/env bash',
    'case "$1" in',
    `  install) touch installed.marker; exit ${installExit} ;;`,
    '  exec) shift; [ "$1" = -- ] && shift; export FAKE_MISE_EXEC=1; exec "$@" ;;',
    'esac',
    'exit 2',
    '',
  ].join('\n');
  await writeFile(path.join(bin, 'mise'), script);
  await chmod(path.join(bin, 'mise'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
}

async function extraDaemon(
  ctx: Ctx,
  opts: { workerId: string; labels: string[]; capacity?: number; leaseMs?: number },
): Promise<Daemon> {
  const daemon = await startDaemon({
    redisUrl,
    keyPrefix: ctx.prefix,
    dataDir: ctx.dataDir,
    workerId: opts.workerId,
    labels: opts.labels,
    capacity: opts.capacity,
    leaseMs: opts.leaseMs ?? ctx.leaseMs,
    heartbeatMs: 200,
    graceMs: 200,
    apiUrl: ctx.base,
    workerToken: 'worker-token-secret-123',
    processImmediately: false,
  });
  const prev = ctx.close;
  ctx.close = async () => {
    await daemon.stop();
    await prev();
  };
  return daemon;
}

async function waitJob(ctx: Ctx, token: string, id: string): Promise<JobRecord> {
  const start = Date.now();
  while (Date.now() - start < 12_000) {
    const response = await call(ctx, token, 'GET', `/v1/jobs/${id}`);
    const job = response.json.job as JobRecord | undefined;
    if (job && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${id}`);
}

function collectSse(ctx: Ctx, token: string, jobId: string): Promise<{ logs: string[]; done: string }> {
  if (!jobId) return Promise.resolve({ logs: [], done: '' });
  return (async () => {
    const response = await fetch(`${ctx.base}/v1/jobs/${jobId}/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    if (!response.ok || !response.body) throw new Error(`sse ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const logs: string[] = [];
    let done = '';
    const timer = setTimeout(() => {
      void reader.cancel();
    }, 8_000);
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (event === 'log' && data.length) {
            const parsed = JSON.parse(data.join('\n')) as { line?: string };
            if (parsed.line) logs.push(parsed.line);
          }
          if (event === 'done') {
            done = data.join('\n');
            clearTimeout(timer);
            await reader.cancel();
            return { logs, done };
          }
          idx = buf.indexOf('\n\n');
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return { logs, done };
  })();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => Promise<boolean> | boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('condition not met');
}
