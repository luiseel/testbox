import { mkdir, appendFile } from 'fs/promises';
import path from 'path';
import IORedis from 'ioredis';
import {
  claimNextJob,
  DEFAULT_RETENTION_MS,
  directoryDigest,
  ensureDependencies,
  fingerprintFromDirectory,
  isTerminal,
  JobStore,
  resolveInside,
  writeRetention,
  type JobEvent,
  type JobRecord,
  type JobState,
} from '@testbox/shared';
import { collectArtifacts } from './artifacts';
import { buildJobEnv, secretsFromEnv } from './env';
import { processStillOwnsJob, runCommand, killProcessGroup } from './executor';
import { hasMiseConfig, miseEnv, miseExecArgv } from './mise';
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
  capacity?: number;
  sshHost?: string | null;
  leaseMs?: number;
  heartbeatMs?: number;
  heartbeatTtlMs?: number;
  pollMs?: number;
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
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private processing = false;
  private stopping = false;
  private pumpPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private inflight = 0;
  private exclusiveHeld = false;
  private readonly aborts = new Map<string, AbortController>();
  private readonly renewals = new Map<string, () => void>();
  private readonly running = new Set<Promise<void>>();
  private readonly simulator: SimulatorControl;
  private readonly env: NodeJS.ProcessEnv;
  private lastRedisError = '';
  private lastRedisErrorAt = 0;

  constructor(private readonly opts: DaemonOptions) {
    this.redis = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null });
    this.redis.on('error', (err: Error) => this.redisError(err));
    this.store = new JobStore(this.redis, opts.keyPrefix);
    this.simulator = opts.simulator ?? simulatorForPlatform();
    this.env = opts.env ?? process.env;
  }

  get leaseMs(): number {
    return this.opts.leaseMs ?? 30_000;
  }

  get capacity(): number {
    return Math.max(1, this.opts.capacity ?? 1);
  }

  get heartbeatTtlMs(): number {
    return this.opts.heartbeatTtlMs ?? 15_000;
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
    if (this.processing) return;
    this.processing = true;
    this.pumpPromise = this.pump();
  }

  /** Stop lease renewal without completing the job, as if this process crashed. */
  simulateCrash(): void {
    for (const stop of this.renewals.values()) stop();
    this.renewals.clear();
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

  /**
   * Run one queued job if this worker is allowed to claim it.
   * The pump is the normal path; this remains for a direct re-entry after a terminal state.
   */
  async handleJob(jobId: string): Promise<void> {
    const existing = await this.store.getJob(jobId);
    if (!existing || existing.state !== 'queued') return;
    const worker = await this.store.getWorker(this.opts.workerId);
    if (worker && existing.requires.some((label) => !worker.labels.includes(label))) return;
    if (existing.targetWorkerId && existing.targetWorkerId !== this.opts.workerId) return;
    const now = Date.now();
    const claimed = await this.store.transition(jobId, ['queued'], 'assigned', {
      workerId: this.opts.workerId,
      attemptId: `attempt_${jobId}`,
      assignedAt: now,
      leaseExpiresAt: now + this.leaseMs,
    });
    if (!claimed.ok) return;
    await this.store.setWorkspaceAffinity(existing.workspaceId, this.opts.workerId);
    await this.runAssigned(jobId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.processing = false;
    this.wake?.();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const stopRenew of this.renewals.values()) stopRenew();
    this.renewals.clear();
    for (const abort of this.aborts.values()) abort.abort('shutdown');
    if (this.pumpPromise) await this.pumpPromise;
    await Promise.allSettled([...this.running]);
    if (this.sub) await this.sub.quit();
    this.sub = null;
    await this.redis.quit();
  }

  private async pump(): Promise<void> {
    while (this.processing) {
      let claimed = false;
      try {
        while (this.processing && this.inflight < this.capacity && !this.exclusiveHeld) {
          const job = await claimNextJob(
            this.store,
            this.opts.workerId,
            Date.now(),
            this.heartbeatTtlMs,
            this.leaseMs,
          );
          if (!job) break;
          claimed = true;
          this.launch(job);
          if (job.resources === 'exclusive') break;
        }
      } catch {
        claimed = false;
      }
      if (!this.processing) break;
      if (!claimed) await this.sleep(this.opts.pollMs ?? 80);
    }
  }

  private launch(job: JobRecord): void {
    if (job.resources === 'exclusive') this.exclusiveHeld = true;
    this.inflight += 1;
    const run = this.runAssigned(job.id).finally(() => {
      this.inflight -= 1;
      if (job.resources === 'exclusive') this.exclusiveHeld = false;
      this.wake?.();
    });
    this.running.add(run);
    void run.finally(() => {
      this.running.delete(run);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async runAssigned(jobId: string): Promise<void> {
    const abort = new AbortController();
    this.aborts.set(jobId, abort);
    if (this.stopping) abort.abort('shutdown');
    const renew = setInterval(() => {
      void this.renew(jobId, abort);
    }, Math.max(50, Math.floor(this.leaseMs / 3)));
    const stopRenew = () => clearInterval(renew);
    this.renewals.set(jobId, stopRenew);

    try {
      const job = await this.requireJob(jobId);
      if (job.cancelRequested) {
        await this.store.transition(jobId, ['assigned'], 'cancelled', {
          endedAt: Date.now(),
          error: 'cancelled',
        });
        return;
      }
      const { mise } = await this.prepare(job);
      const running = await this.store.transition(jobId, ['assigned'], 'running', {
        startedAt: Date.now(),
        leaseExpiresAt: Date.now() + this.leaseMs,
      });
      if (!running.ok) return;

      const result = await runCommand({
        cwd: resolveInside(this.opts.dataDir, job.snapshotRelPath),
        env: this.jobEnv(job.id, mise),
        timeoutMs: job.timeoutMs,
        graceMs: this.opts.graceMs ?? 2_000,
        abortSignal: abort.signal,
        secrets: secretsFromEnv(this.env),
        shell: mise ? { argv: miseExecArgv(['bash', '-c', job.command]) } : { command: job.command },
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
      stopRenew();
      this.renewals.delete(jobId);
      this.aborts.delete(jobId);
    }
  }

  private jobEnv(jobId: string, mise: boolean): NodeJS.ProcessEnv {
    const env = buildJobEnv(this.env, [], jobId);
    return mise ? miseEnv(env, this.opts.dataDir) : env;
  }

  private async prepare(job: JobRecord): Promise<{ mise: boolean }> {
    const cwd = resolveInside(this.opts.dataDir, job.snapshotRelPath);
    const actual = await directoryDigest(cwd);
    if (actual !== job.snapshotDigest) {
      throw new Error('snapshot digest mismatch');
    }
    const mise = await this.useMise(job, cwd);
    if (mise) await this.miseInstall(job, cwd);
    const fingerprint = await fingerprintFromDirectory(cwd, await probeRuntime());
    const withMise = (argv: string[]) => (mise ? miseExecArgv(argv) : argv);
    const install =
      this.opts.install ??
      (async (dir: string, storeDir: string) => {
        const installed = await runCommand({
          cwd: dir,
          env: this.jobEnv(job.id, mise),
          timeoutMs: 15 * 60 * 1000,
          graceMs: this.opts.graceMs ?? 2_000,
          secrets: secretsFromEnv(this.env),
          shell: { argv: withMise(['pnpm', 'install', '--frozen-lockfile', '--store-dir', storeDir]) },
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
    if (job.resources === 'exclusive' && this.simulator.enabled !== false) {
      await this.simulator.reset();
      await this.noteLog(job.id, 'stderr', 'reset simulators for exclusive job');
    }
    return { mise };
  }

  /** Use mise only when the snapshot has a mise config and this worker has mise on `PATH`. */
  private async useMise(job: JobRecord, cwd: string): Promise<boolean> {
    if (!(await hasMiseConfig(cwd))) return false;
    if (this.opts.labels.includes('mise')) return true;
    await this.noteLog(job.id, 'stderr', 'mise config found, but this worker has no mise; using worker tools');
    return false;
  }

  private async miseInstall(job: JobRecord, cwd: string): Promise<void> {
    await this.noteLog(job.id, 'stderr', 'mise install');
    const result = await runCommand({
      cwd,
      env: this.jobEnv(job.id, true),
      timeoutMs: 15 * 60 * 1000,
      graceMs: this.opts.graceMs ?? 2_000,
      secrets: secretsFromEnv(this.env),
      shell: { argv: ['mise', 'install'] },
      onLog: (event) => {
        void this.noteLog(job.id, event.stream, event.text);
      },
    });
    if (result.exitCode !== 0) {
      const message = `mise install failed with exit ${result.exitCode ?? 'null'}`;
      await this.noteLog(job.id, 'stderr', message);
      throw new Error(message);
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
      capacity: this.capacity,
      lastSeen: Date.now(),
      sshHost: this.opts.sshHost ?? null,
    });
  }

  private async subscribe(): Promise<void> {
    this.sub = new IORedis(this.opts.redisUrl, { maxRetriesPerRequest: null });
    this.sub.on('error', (err: Error) => this.redisError(err));
    await this.sub.subscribe(this.store.k('events'));
    this.sub.on('message', (_channel: string, message: string) => {
      let event: JobEvent;
      try {
        event = JSON.parse(message) as JobEvent;
      } catch {
        return;
      }
      if (event.type === 'cancel') {
        this.aborts.get(event.jobId)?.abort('cancel');
      }
      if (event.type === 'state' && event.state === 'queued') {
        this.wake?.();
      }
    });
  }

  /**
   * ioredis reconnects by itself. Without a listener it prints a stack trace
   * for each attempt; print one line, and again only when the error changes
   * or a minute has passed.
   */
  private redisError(err: Error): void {
    // The local port in "connect EHOSTUNREACH a:6379 - Local (b:56921)" changes on each try.
    const message = err.message.replace(/ - Local \(.*\)$/, '');
    const now = Date.now();
    if (message === this.lastRedisError && now - this.lastRedisErrorAt < 60_000) return;
    this.lastRedisError = message;
    this.lastRedisErrorAt = now;
    process.stderr.write(`redis: ${message}\n`);
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
