import { DynamicModule, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { JobStore, bullConnection, bullPrefix, QUEUE_NAME } from '@testbox/shared';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CleanupService, LeaseSweeper } from './cleanup.service';
import {
  AdminController,
  HealthController,
  JobsController,
  UsersController,
  WorkersController,
  WorkspacesController,
} from './controllers';
import { EventsHub } from './events.hub';
import { AllExceptionsFilter } from './filter';
import { JobsService } from './jobs.service';
import { APP_OPTIONS, EVENTS, JOB_QUEUE, JOB_STORE, type AppOptions } from './options';

class AppLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly auth: AuthService,
    private readonly events: EventsHub,
    private readonly queue: Queue,
    private readonly store: JobStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.auth.ensureBootstrap();
    await this.events.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.events.close();
    await this.store.redis.quit();
  }
}

@Module({})
export class AppModule {
  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        UsersController,
        WorkspacesController,
        JobsController,
        WorkersController,
        AdminController,
      ],
      providers: [
        { provide: APP_OPTIONS, useValue: options },
        {
          provide: JOB_STORE,
          inject: [APP_OPTIONS],
          useFactory: (opts: AppOptions) =>
            new JobStore(new IORedis(opts.redisUrl, { maxRetriesPerRequest: null }), opts.keyPrefix),
        },
        {
          provide: JOB_QUEUE,
          inject: [APP_OPTIONS],
          useFactory: (opts: AppOptions) =>
            new Queue(QUEUE_NAME, {
              connection: bullConnection(opts.redisUrl),
              prefix: bullPrefix(opts.keyPrefix),
            }),
        },
        {
          provide: EVENTS,
          inject: [APP_OPTIONS],
          useFactory: (opts: AppOptions) => new EventsHub(opts.redisUrl, opts.keyPrefix),
        },
        AuthService,
        JobsService,
        CleanupService,
        LeaseSweeper,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        {
          provide: AppLifecycle,
          inject: [AuthService, EVENTS, JOB_QUEUE, JOB_STORE],
          useFactory: (auth: AuthService, events: EventsHub, queue: Queue, store: JobStore) =>
            new AppLifecycle(auth, events, queue, store),
        },
      ],
    };
  }
}
