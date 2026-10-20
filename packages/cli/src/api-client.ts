import { exitCodeForApiError, type JobSource, type JobState } from '@testbox/shared';

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

export function exitCodeForCliError(err: unknown): number | null {
  if (err instanceof CliApiError) return exitCodeForApiError(err.code, err.status);
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

export class HttpApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
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

  async healthy(): Promise<boolean> {
    try {
      await this.request('GET', '/v1/healthz');
      return true;
    } catch {
      return false;
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

  registerSnapshot(workspaceId: string, snapshot: { id: string; digest: string }): Promise<{ id: string; digest: string; relPath: string }> {
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

  getJob(id: string): Promise<{ job: JobPayload }> {
    return this.request('GET', `/v1/jobs/${id}`);
  }

  cancel(id: string): Promise<{ job: JobPayload }> {
    return this.request('POST', `/v1/jobs/${id}/cancel`);
  }

  logs(id: string): Promise<{ lines: { stream: 'stdout' | 'stderr'; line: string; offset: number }[]; state: JobState }> {
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
    const body = await this.request<{ workers: { id: string; healthy: boolean; labels: string[]; sshHost?: string | null }[] }>(
      'GET',
      '/v1/workers',
    );
    return body.workers;
  }

  async listArtifacts(id: string): Promise<{ path: string; size: number }[]> {
    const body = await this.request<{ files: { path: string; size: number }[] }>('GET', `/v1/jobs/${id}/artifacts`);
    return body.files;
  }

  async downloadArtifact(id: string, relPath: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(
      this.url(`/v1/jobs/${id}/artifacts/content?path=${encodeURIComponent(relPath)}`),
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok) {
      throw new CliApiError('artifact download failed', response.status === 401 ? 'AUTH' : 'BAD_REQUEST', response.status);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async stream(
    id: string,
    onEvent: (event: string, data: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(this.url(`/v1/jobs/${id}/events`), {
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
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
      const chunk = await reader.read();
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
