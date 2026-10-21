import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError, isTerminal, JOB_SOURCE_MAX_LENGTH, JOB_SOURCE_MAX_LINKS, JobStore, SAFE_SEGMENT, type JobRecord } from '@testbox/shared';
import { listArtifactFiles, openArtifact, readRequestBody, saveArtifact } from './artifacts';
import { AuthService } from './auth.service';
import { AuthedRequest, Public, Roles } from './auth.guard';
import { CleanupService } from './cleanup.service';
import { EventsHub } from './events.hub';
import { JobsService } from './jobs.service';
import { APP_OPTIONS, EVENTS, JOB_STORE, type AppOptions } from './options';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      'BAD_REQUEST',
      result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
      400,
    );
  }
  return result.data;
}

function publicJob(job: JobRecord): Omit<JobRecord, 'queueKey'> {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    snapshotId: job.snapshotId,
    snapshotRelPath: job.snapshotRelPath,
    snapshotDigest: job.snapshotDigest,
    snapshotWorkDir: job.snapshotWorkDir,
    ownerId: job.ownerId,
    command: job.command,
    profile: job.profile,
    artifactGlobs: job.artifactGlobs,
    requires: job.requires,
    priority: job.priority,
    timeoutMs: job.timeoutMs,
    state: job.state,
    createdAt: job.createdAt,
    assignedAt: job.assignedAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    workerId: job.workerId,
    targetWorkerId: job.targetWorkerId,
    source: job.source,
    attemptId: job.attemptId,
    exitCode: job.exitCode,
    error: job.error,
    cancelRequested: job.cancelRequested,
    leaseExpiresAt: job.leaseExpiresAt,
    pgid: job.pgid,
    retentionUntil: job.retentionUntil,
  };
}

@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  health(): { ok: true } {
    return { ok: true };
  }
}

@Controller('users')
export class UsersController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('me')
  me(@Req() req: AuthedRequest): { id: string; name: string; role: string } {
    return { id: req.principal.id, name: req.principal.name, role: req.principal.role };
  }

  /** Admin lookup by name, so `testbox admin add-user` can issue a new token to an existing user. */
  @Roles('admin')
  @Get()
  async find(@Query('name') name: string | undefined): Promise<{ users: { id: string; name: string; role: string }[] }> {
    const input = parse(z.object({ name: z.string().min(1) }), { name });
    const user = await this.auth.findUserByName(input.name);
    return { users: user ? [{ id: user.id, name: user.name, role: user.role }] : [] };
  }

  @Roles('admin')
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown): Promise<{ id: string; name: string }> {
    const input = parse(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/) }), body);
    const user = await this.auth.createUser(input.name, req.principal.id);
    return { id: user.id, name: user.name };
  }

  @Roles('admin')
  @Post(':id/tokens')
  async token(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ token: string; userId: string }> {
    const token = await this.auth.issueToken(id, req.principal.id);
    return { token, userId: id };
  }
}

@Controller('workspaces')
export class WorkspacesController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({ project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/) }),
      body,
    );
    return this.jobs.createWorkspace(req.principal.id, input.project);
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    return { workspaces: await this.jobs.listWorkspaces(req.principal.id) };
  }

  @Get(':id')
  async get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.jobs.getWorkspace(id, req.principal.id);
  }

  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.jobs.deleteWorkspace(id, req.principal.id);
    return { ok: true };
  }

  @Post(':id/snapshots')
  async snapshot(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        id: z.string().regex(/^snap_[a-f0-9]{24}$/),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        workDir: z.string().regex(SAFE_SEGMENT).optional(),
      }),
      body,
    );
    return this.jobs.registerSnapshot(id, req.principal.id, input);
  }
}

@Controller('jobs')
export class JobsController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(EVENTS) private readonly hub: EventsHub,
    @Inject(APP_OPTIONS) private readonly options: AppOptions,
  ) {}

  @Post()
  async create(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const input = parse(
      z.object({
        workspaceId: z.string().min(1),
        snapshotId: z.string().regex(/^snap_[a-f0-9]{24}$/),
        command: z.string().min(1).max(10_000),
        profile: z.string().min(1).max(100).nullable().optional(),
        artifactGlobs: z.array(z.string()).optional(),
        requires: z.array(z.string()).optional(),
        targetWorkerId: z.string().min(1).max(200).nullable().optional(),
        priority: z.number().int().min(0).max(999).optional(),
        timeoutMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
        idempotencyKey: z.string().min(8).max(200).optional(),
        source: z
          .object({
            path: z.string().min(1).max(JOB_SOURCE_MAX_LENGTH),
            branch: z.string().max(JOB_SOURCE_MAX_LENGTH).optional(),
            commit: z.string().max(JOB_SOURCE_MAX_LENGTH).optional(),
            dirty: z.boolean().optional(),
            links: z
              .array(
                z.object({
                  name: z.string().regex(SAFE_SEGMENT),
                  path: z.string().min(1).max(JOB_SOURCE_MAX_LENGTH),
                  branch: z.string().max(JOB_SOURCE_MAX_LENGTH).optional(),
                  commit: z.string().max(JOB_SOURCE_MAX_LENGTH).optional(),
                  dirty: z.boolean().optional(),
                }),
              )
              .max(JOB_SOURCE_MAX_LINKS)
              .optional(),
          })
          .optional(),
      }),
      body,
    );
    const created = await this.jobs.createJob(req.principal, {
      ...input,
      idempotencyKey: idempotencyKey || input.idempotencyKey,
    });
    return { job: publicJob(created.job), superseded: created.superseded };
  }

  @Get(':id')
  async get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return { job: publicJob(await this.jobs.getJob(id, req.principal.id)) };
  }

  @Get(':id/logs')
  async logs(@Req() req: AuthedRequest, @Param('id') id: string, @Query('offset') offset?: string) {
    const from = offset ? Number(offset) : 1;
    return this.jobs.readLogs(id, req.principal.id, Number.isFinite(from) ? from : 1);
  }

  @Post(':id/cancel')
  async cancel(@Req() req: AuthedRequest, @Param('id') id: string) {
    return { job: publicJob(await this.jobs.cancel(id, req.principal.id)) };
  }

  @Get(':id/events')
  async events(@Req() req: AuthedRequest, @Param('id') id: string, @Res() res: Response, @Query('offset') offset?: string) {
    const job = await this.jobs.getJob(id, req.principal.id);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let closed = false;
    let cursor = offset ? Number(offset) : 1;
    if (!Number.isFinite(cursor) || cursor < 1) cursor = 1;
    const write = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finish = (state: JobRecord['state'], exitCode: number | null, error: string | null) => {
      write('done', { state, exitCode, error });
      cleanup();
    };
    const unsub = this.hub.subscribe((event) => {
      if (event.jobId !== id) return;
      if (event.type === 'log') {
        if (event.offset < cursor) return;
        cursor = event.offset + 1;
        write('log', { offset: event.offset, stream: event.stream, line: event.line });
      } else if (event.type === 'state') {
        write('state', { state: event.state, exitCode: event.exitCode, error: event.error });
        if (isTerminal(event.state)) finish(event.state, event.exitCode, event.error);
      }
    });
    const backlog = await this.store.readLogs(id, cursor);
    for (const line of backlog) {
      write('log', line);
      cursor = line.offset + 1;
    }
    write('state', { state: job.state, exitCode: job.exitCode, error: job.error });
    const poll = setInterval(() => {
      void this.store.getJob(id).then((current) => {
        if (!current) return;
        write('state', { state: current.state, exitCode: current.exitCode, error: current.error });
        if (isTerminal(current.state)) finish(current.state, current.exitCode, current.error);
      }).catch(() => undefined);
    }, 500);
    const ping = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(ping);
      unsub();
      res.end();
    };
    req.on('close', cleanup);
    if (isTerminal(job.state)) finish(job.state, job.exitCode, job.error);
  }

  @Roles('worker')
  @Post(':id/artifacts')
  async upload(@Req() req: AuthedRequest, @Param('id') id: string) {
    const job = await this.store.getJob(id);
    if (!job) throw new AppError('NOT_FOUND', 'job not found', 404);
    const header = req.header('x-artifact-path');
    if (!header) throw new AppError('BAD_REQUEST', 'x-artifact-path is required', 400);
    const body = await readRequestBody(req, 50 * 1024 * 1024);
    return saveArtifact({
      dataDir: this.options.dataDir,
      jobId: id,
      relPath: header,
      body,
      retentionUntil: job.retentionUntil,
    });
  }

  @Get(':id/artifacts')
  async artifacts(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.jobs.getJob(id, req.principal.id);
    return { files: await listArtifactFiles(this.options.dataDir, id) };
  }

  @Get(':id/artifacts/content')
  async artifactContent(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query('path') relPath: string,
    @Res() res: Response,
  ) {
    await this.jobs.getJob(id, req.principal.id);
    if (!relPath) throw new AppError('BAD_REQUEST', 'path is required', 400);
    const stream = openArtifact(this.options.dataDir, id, relPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'artifact not found' } });
      else res.end();
    });
    stream.pipe(res);
  }
}

@Controller('workers')
export class WorkersController {
  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(APP_OPTIONS) private readonly options: AppOptions,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  @Post('select')
  async select(@Body() body: unknown) {
    const input = parse(
      z.object({
        requires: z.array(z.string()).optional(),
        workspaceId: z.string().min(1).nullable().optional(),
      }),
      body,
    );
    const worker = await this.jobs.selectWorker(input);
    return {
      worker: {
        ...worker,
        healthy: Date.now() - worker.lastSeen <= this.options.heartbeatTtlMs,
      },
    };
  }

  @Get()
  async list() {
    const now = Date.now();
    const workers = await this.store.listWorkers();
    return {
      workers: workers.map((worker) => ({
        ...worker,
        healthy: now - worker.lastSeen <= this.options.heartbeatTtlMs,
      })),
    };
  }
}

@Controller('admin')
export class AdminController {
  constructor(
    @Inject(CleanupService) private readonly cleanup: CleanupService,
    @Inject(JOB_STORE) private readonly store: JobStore,
  ) {}

  @Roles('admin')
  @Post('cleanup')
  async cleanupNow() {
    return this.cleanup.runOnce();
  }

  @Roles('admin')
  @Get('audit')
  async audit() {
    return { entries: await this.store.listAudit() };
  }
}
