import { mkdir, appendFile } from 'fs/promises';
import path from 'path';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import {
  bullConnection,
  bullPrefix,
  DEFAULT_RETENTION_MS,
  directoryDigest,
  ensureDependencies,
  fingerprintFromDirectory,
  isTerminal,
  JobStore,
  QUEUE_NAME,
  resolveInside,
  writeRetention,
  type JobEvent,
  type JobRecord,
  type JobState,
} from '@testbox/shared';
import { collectArtifacts } from './artifacts';
import { buildJobEnv, secretsFromEnv } from './env';
import { processStillOwnsJob, runCommand, killProcessGroup } from './executor';
import { probeRuntime } from './probe';
import { simulatorForPlatform, type SimulatorControl } from './simulator';
import { uploadArtifacts } from './upload';

export interface DaemonOptions {
  redisUrl: string;
  keyPrefix: string;
  dataDir: string;
  workerId: string;
  labels: string[];
  hostname?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  graceMs?: number;
  retentionMs?: number;
  apiUrl?: string;
  workerToken?: string;
  processImmediately?: boolean;
  simulator?: SimulatorControl;
  install?: (cwd: string, storeDir: string) => Promise<number>;
  env?: NodeJS.ProcessEnv;
}

export class Daemon {
  readonly store: JobStore;
  private readonly redis: IORedis;
  private sub: IORedis | null = null;
  private bull: Worker | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopRenewal: (() => void) | null = null;
  private currentAbort: AbortController | null = null;
  private currentJobId: string | null = null;
  private readonly simulator: SimulatorControl;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: DaemonOptions) {
    this.redis = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null });
    this.store = new JobStore(this.redis, opts.keyPrefix);
    this.simulator = opts.simulator ?? simulatorForPlatform();
    this.env = opts.env ?? process.env;
  }

  get leaseMs(): number {
    return this.opts.leaseMs ?? 30_000;
  }

  async ready(): Promise<void> {
    await this.heartbeatOnce();
  }

  async start(): Promise<void> {
    await this.ready();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatOnce().catch(() => undefined);
    }, this.opts.heartbeatMs ?? 5_000);
    await this.subscribe();
    if (this.opts.processImmediately !== false) {
      await this.startProcessing();
    }
    await this.reapOrphans();
  }

  async startProcessing(): Promise<void> {
    if (this.bull) return;
    this.bull = new Worker(
      QUEUE_NAME,
      async (bullJob) => {
        const data = bullJob.data as { jobId?: string };
        if (!data.jobId) return;
        await this.handleJob(data.jobId);
      },
      {
        connection: bullConnection(this.opts.redisUrl),
        prefix: bullPrefix(this.opts.keyPrefix),
        concurrency: 1,
        lockDuration: 60_000,
        stalledInterval: 30_000,
        maxStalledCount: 0,
      },
    );
    this.bull.on('error', () => undefined);
    await this.bull.waitUntilReady();
  }

  /** Stop lease renewal without completing the job, as if this process crashed. */
  simulateCrash(): void {
    this.stopRenewal?.();
    this.stopRenewal = null;
  }

  async reapOrphans(): Promise<void> {
    const jobs = await this.store.listAllJobs();
    for (const job of jobs) {
      if (!job.pgid) continue;
      if (job.state !== 'timed_out' && job.state !== 'cancelled' && job.state !== 'failed') continue;
      if (await processStillOwnsJob(job.pgid, job.id)) {
        try {
          killProcessGroup(job.pgid, 'SIGKILL');
        } catch {
          // already gone, or not our process
        }
      }
    }
  }

  async handleJob(jobId: string): Promise<void> {
    const existing = await this.store.getJob(jobId);
    if (!existing || existing.state !== 'queued') return;

    const now = Date.now();
    const claimed = await this.store.transition(jobId, ['queued'], 'assigned', {
      workerId: this.opts.workerId,
      attemptId: `attempt_${jobId}`,
      assignedAt: now,
      leaseExpiresAt: now + this.leaseMs,
    });
    if (!claimed.ok) return;

    const abort = new AbortController();
    this.currentAbort = abort;
    this.currentJobId = jobId;
    const renew = setInterval(() => {
      void this.renew(jobId, abort);
    }, Math.max(50, Math.floor(this.leaseMs / 3)));
    this.stopRenewal = () => clearInterval(renew);

    try {
      const job = await this.requireJob(jobId);
      if (job.cancelRequested) {
        await this.store.transition(jobId, ['assigned'], 'cancelled', {
          endedAt: Date.now(),
          error: 'cancelled',
        });
        return;
      }
      await this.prepare(job);
      const running = await this.store.transition(jobId, ['assigned'], 'running', {
        startedAt: Date.now(),
        leaseExpiresAt: Date.now() + this.leaseMs,
      });
      if (!running.ok) return;

      const result = await runCommand({
        cwd: resolveInside(this.opts.dataDir, job.snapshotRelPath),
        env: buildJobEnv(this.env, [], job.id),
        timeoutMs: job.timeoutMs,
        graceMs: this.opts.graceMs ?? 2_000,
        abortSignal: abort.signal,
        secrets: secretsFromEnv(this.env),
        shell: { command: job.command },
        onSpawn: (pgid) => {
          void this.store.setPgid(job.id, pgid);
        },
        onLog: (event) => {
          void this.noteLog(job.id, event.stream, event.text);
        },
      });

      await this.collect(job);
      const latest = await this.store.getJob(jobId);
      if (!latest || isTerminal(latest.state)) return;
      const next = nextState(result, latest.cancelRequested);
      await this.store.transition(jobId, ['running'], next.state, {
        endedAt: Date.now(),
        exitCode: result.exitCode,
        error: next.error,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'job failed';
      await this.store.transition(jobId, ['assigned', 'running'], 'failed', {
        endedAt: Date.now(),
        error: message,
      });
    } finally {
      clearInterval(renew);
      if (this.stopRenewal) this.stopRenewal = null;
      if (this.currentJobId === jobId) {
        this.currentJobId = null;
        this.currentAbort = null;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.stopRenewal?.();
    this.currentAbort?.abort('shutdown');
    if (this.bull) await this.bull.close();
    if (this.sub) await this.sub.quit();
    this.sub = null;
    await this.redis.quit();
  }

  private async prepare(job: JobRecord): Promise<void> {
    const cwd = resolveInside(this.opts.dataDir, job.snapshotRelPath);
    const actual = await directoryDigest(cwd);
    if (actual !== job.snapshotDigest) {
      throw new Error('snapshot digest mismatch');
    }
    const fingerprint = await fingerprintFromDirectory(cwd, await probeRuntime());
    const install =
      this.opts.install ??
      (async (dir: string, storeDir: string) => {
        const installed = await runCommand({
          cwd: dir,
          env: buildJobEnv(this.env, [], job.id),
          timeoutMs: 15 * 60 * 1000,
          graceMs: this.opts.graceMs ?? 2_000,
          secrets: secretsFromEnv(this.env),
          shell: { argv: ['pnpm', 'install', '--frozen-lockfile', '--store-dir', storeDir] },
        });
        return installed.exitCode ?? 1;
      });
    await ensureDependencies({
      snapshotDir: cwd,
      cacheDir: path.join(this.opts.dataDir, 'cache'),
      workspaceKey: job.workspaceId,
      fingerprint,
      install,
    });
    if (job.resources === 'exclusive') {
      await this.simulator.reset();
      await this.noteLog(job.id, 'stderr', 'reset simulators for exclusive job');
    }
  }

  private async collect(job: JobRecord): Promise<void> {
    if (!this.opts.apiUrl || !this.opts.workerToken || job.artifactGlobs.length === 0) return;
    const cwd = resolveInside(this.opts.dataDir, job.snapshotRelPath);
    const files = await collectArtifacts(cwd, job.artifactGlobs, 50 * 1024 * 1024);
    await uploadArtifacts({
      apiUrl: this.opts.apiUrl,
      token: this.opts.workerToken,
      jobId: job.id,
      files,
    });
  }

  private async noteLog(jobId: string, stream: 'stdout' | 'stderr', text: string): Promise<void> {
    await this.store.appendLog(jobId, stream, text);
    const dir = path.join(this.opts.dataDir, 'logs', jobId);
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, stream === 'stdout' ? 'stdout.log' : 'stderr.log'), `${text}\n`);
    const job = await this.store.getJob(jobId);
    if (job) {
      await writeRetention(this.opts.dataDir, 'logs', jobId, job.retentionUntil || Date.now() + (this.opts.retentionMs ?? DEFAULT_RETENTION_MS));
    }
  }

  private async renew(jobId: string, abort: AbortController): Promise<void> {
    const renewed = await this.store.renewLease(jobId, this.opts.workerId, Date.now() + this.leaseMs);
    if (!renewed.ok) {
      abort.abort(renewed.state === 'cancelled' ? 'cancel' : 'lease');
      return;
    }
    const job = await this.store.getJob(jobId);
    if (job?.cancelRequested) abort.abort('cancel');
  }

  private async heartbeatOnce(): Promise<void> {
    await this.store.upsertWorker({
      id: this.opts.workerId,
      hostname: this.opts.hostname ?? 'localhost',
      os: process.platform,
      arch: process.arch,
      labels: this.opts.labels,
      capacity: 1,
      lastSeen: Date.now(),
    });
  }

  private async subscribe(): Promise<void> {
    this.sub = new IORedis(this.opts.redisUrl, { maxRetriesPerRequest: null });
    await this.sub.subscribe(this.store.k('events'));
    this.sub.on('message', (_channel: string, message: string) => {
      let event: JobEvent;
      try {
        event = JSON.parse(message) as JobEvent;
      } catch {
        return;
      }
      if (event.type === 'cancel' && event.jobId === this.currentJobId) {
        this.currentAbort?.abort('cancel');
      }
    });
  }

  private async requireJob(id: string): Promise<JobRecord> {
    const job = await this.store.getJob(id);
    if (!job) throw new Error(`missing job ${id}`);
    return job;
  }
}

function nextState(
  result: { exitCode: number | null; timedOut: boolean; cancelled: boolean },
  cancelRequested: boolean,
): { state: JobState; error: string | null } {
  if (cancelRequested || result.cancelled) return { state: 'cancelled', error: 'cancelled' };
  if (result.timedOut) return { state: 'timed_out', error: 'timeout' };
  if (result.exitCode === 0) return { state: 'succeeded', error: null };
  return { state: 'failed', error: `exit ${result.exitCode ?? 'null'}` };
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const daemon = new Daemon(opts);
  await daemon.start();
  return daemon;
}
