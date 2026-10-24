import { ExitCode, exitCodeForApiError, type JobSource, type JobState } from '@testbox/shared';

export class CliApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CliApiError';
  }
}

/** True for an abort by the caller (Ctrl-C, detach): not a failure of the API. */
export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** True when `value` is an http or https URL, which is what `--api-url` must be. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The API address for a message: the origin, or the raw value when it is not a URL. Never throws. */
export function apiAddress(apiUrl: string): string {
  try {
    return new URL(apiUrl).origin;
  } catch {
    return apiUrl;
  }
}

/** The API gave no answer: no route, nothing listens, the request timed out, or the connection dropped. Not an HTTP error. */
export class ApiUnreachableError extends Error {
  constructor(apiUrl: string, cause: unknown) {
    const why = errorCode(cause) ?? (cause instanceof Error ? cause.message : String(cause));
    super(`cannot reach the API at ${apiAddress(apiUrl)}: ${why}`, { cause });
    this.name = 'ApiUnreachableError';
  }
}

export function exitCodeForCliError(err: unknown): number | null {
  if (err instanceof CliApiError) return exitCodeForApiError(err.code, err.status);
  if (err instanceof ApiUnreachableError) return ExitCode.ApiUnreachable;
  return null;
}

interface JobPayload {
  id: string;
  state: JobState;
  exitCode: number | null;
  error: string | null;
  profile: string | null;
  command: string;
  source?: JobSource | null;
}

/** The result of the health check. `refused`: the host answers, nothing listens. `unreachable`: no answer at all. */
export type ApiHealth = { ok: true } | { ok: false; reason: 'refused' | 'unreachable' | 'unhealthy'; detail: string };

/** The `code` of a fetch error, which Node keeps in `cause` (ECONNREFUSED, ETIMEDOUT, ...). */
function errorCode(err: unknown): string | undefined {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export class HttpApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Runs one step of the transport (the request, or a read of the body) and turns a network failure into
   * ApiUnreachableError, so the exit code is 21, not 1. An abort by the caller passes through.
   */
  private async transport<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ApiUnreachableError(this.baseUrl, err);
    }
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.transport(() =>
      this.fetchImpl(this.url(path), {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await this.transport(() => response.text());
    let parsed: { error?: { code?: string; message?: string } } = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        parsed = {};
      }
    }
    if (!response.ok) {
      throw new CliApiError(
        parsed.error?.message ?? response.statusText,
        parsed.error?.code ?? 'BAD_REQUEST',
        response.status,
      );
    }
    return parsed as T;
  }

  me(): Promise<{ id: string; name: string; role: string }> {
    return this.request('GET', '/v1/users/me');
  }

  findUser(name: string): Promise<{ users: { id: string; name: string; role: string }[] }> {
    return this.request('GET', `/v1/users?name=${encodeURIComponent(name)}`);
  }

  createUser(name: string): Promise<{ id: string; name: string }> {
    return this.request('POST', '/v1/users', { name });
  }

  issueToken(userId: string): Promise<{ token: string; userId: string }> {
    return this.request('POST', `/v1/users/${encodeURIComponent(userId)}/tokens`);
  }

  /** True when the API answers the health check. `admin` polls this while the control plane starts. */
  async healthy(): Promise<boolean> {
    return (await this.health()).ok;
  }

  /** Why the API does not answer, so doctor can say what to do. Gives up after 10 seconds. */
  async health(): Promise<ApiHealth> {
    try {
      await this.request('GET', '/v1/healthz', undefined, undefined, AbortSignal.timeout(10_000));
      return { ok: true };
    } catch (err) {
      if (err instanceof CliApiError) return { ok: false, reason: 'unhealthy', detail: `HTTP ${err.status}` };
      const root = err instanceof ApiUnreachableError ? err.cause : err;
      const code = errorCode(root);
      if (code === 'ECONNREFUSED') return { ok: false, reason: 'refused', detail: code };
      return {
        ok: false,
        reason: 'unreachable',
        detail: code ?? (root instanceof Error ? root.message : String(root)),
      };
    }
  }

  createWorkspace(project: string): Promise<{ id: string; stagingRel: string; project: string; ownerId: string }> {
    return this.request('POST', '/v1/workspaces', { project });
  }

  getWorkspace(id: string): Promise<{ id: string; stagingRel: string; project: string; ownerId: string }> {
    return this.request('GET', `/v1/workspaces/${id}`);
  }

  deleteWorkspace(id: string): Promise<unknown> {
    return this.request('DELETE', `/v1/workspaces/${id}`);
  }

  registerSnapshot(
    workspaceId: string,
    snapshot: { id: string; digest: string; workDir?: string },
  ): Promise<{ id: string; digest: string; relPath: string; workDir?: string }> {
    return this.request('POST', `/v1/workspaces/${workspaceId}/snapshots`, snapshot);
  }

  createJob(input: {
    workspaceId: string;
    snapshotId: string;
    command: string;
    profile?: string | null;
    artifactGlobs?: string[];
    requires?: string[];
    priority?: number;
    timeoutMs?: number;
    targetWorkerId?: string;
    source?: JobSource;
  }): Promise<{ job: JobPayload; superseded: string[] }> {
    return this.request('POST', '/v1/jobs', input);
  }

  /** `signal` stops the request, for example when the CLI detaches while it waits for the final state. */
  getJob(id: string, signal?: AbortSignal): Promise<{ job: JobPayload }> {
    return this.request('GET', `/v1/jobs/${id}`, undefined, undefined, signal);
  }

  cancel(id: string): Promise<{ job: JobPayload }> {
    return this.request('POST', `/v1/jobs/${id}/cancel`);
  }

  logs(
    id: string,
  ): Promise<{ lines: { stream: 'stdout' | 'stderr'; line: string; offset: number }[]; state: JobState }> {
    return this.request('GET', `/v1/jobs/${id}/logs`);
  }

  async selectWorker(input: {
    requires: string[];
    workspaceId?: string;
  }): Promise<{ id: string; sshHost: string | null; labels: string[] } | null> {
    const body = await this.request<{ worker?: { id?: string; sshHost?: string | null; labels?: string[] } }>(
      'POST',
      '/v1/workers/select',
      input,
    );
    if (!body.worker?.id) return null;
    return {
      id: body.worker.id,
      sshHost: body.worker.sshHost ?? null,
      labels: body.worker.labels ?? [],
    };
  }

  async listWorkers(): Promise<{ id: string; healthy: boolean; labels: string[]; sshHost?: string | null }[]> {
    const body = await this.request<{
      workers: { id: string; healthy: boolean; labels: string[]; sshHost?: string | null }[];
    }>('GET', '/v1/workers');
    return body.workers;
  }

  async listArtifacts(id: string): Promise<{ path: string; size: number }[]> {
    const body = await this.request<{ files: { path: string; size: number }[] }>('GET', `/v1/jobs/${id}/artifacts`);
    return body.files;
  }

  async downloadArtifact(id: string, relPath: string): Promise<Uint8Array> {
    const response = await this.transport(() =>
      this.fetchImpl(this.url(`/v1/jobs/${id}/artifacts/content?path=${encodeURIComponent(relPath)}`), {
        headers: { authorization: `Bearer ${this.token}` },
      }),
    );
    if (!response.ok) {
      throw new CliApiError(
        'artifact download failed',
        response.status === 401 ? 'AUTH' : 'BAD_REQUEST',
        response.status,
      );
    }
    return new Uint8Array(await this.transport(() => response.arrayBuffer()));
  }

  async stream(id: string, onEvent: (event: string, data: string) => void, signal: AbortSignal): Promise<void> {
    const response = await this.transport(() =>
      this.fetchImpl(this.url(`/v1/jobs/${id}/events`), {
        headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
        signal,
      }),
    );
    if (!response.ok || !response.body) {
      const text = await this.transport(() => response.text());
      let code = 'BAD_REQUEST';
      let message = response.statusText;
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        // ignore
      }
      throw new CliApiError(message, code, response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (!signal.aborted) {
      const chunk = await this.transport(() => reader.read());
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let split = buf.indexOf('\n\n');
      while (split >= 0) {
        const raw = buf.slice(0, split);
        buf = buf.slice(split + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length > 0) onEvent(event, data.join('\n'));
        split = buf.indexOf('\n\n');
      }
    }
  }
}
