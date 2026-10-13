import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cleanupExpired, isTerminal, JobStore } from '@testbox/shared';
import { APP_OPTIONS, JOB_STORE, type AppOptions } from './options';

@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(APP_OPTIONS) private readonly options: AppOptions,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, 60 * 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = Date.now()): Promise<{ removed: string[] }> {
    const removed = await cleanupExpired(this.options.dataDir, now);
    const jobs = await this.store.listAllJobs();
    for (const job of jobs) {
      if (!isTerminal(job.state)) continue;
      if (job.retentionUntil > now) continue;
      await this.store.deleteJobData(job.id);
      removed.removed.push(`redis/${job.id}`);
    }
    return removed;
  }
}

@Injectable()
export class LeaseSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(APP_OPTIONS) private readonly options: AppOptions,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.store.expireLeases(Date.now()).catch(() => undefined);
    }, this.options.sweeperMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
