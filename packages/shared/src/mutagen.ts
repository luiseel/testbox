export function assertSessionName(name: string): void {
  // Mutagen session names allow only letters, digits, and dashes.
  if (!/^[A-Za-z][A-Za-z0-9-]{0,80}$/.test(name)) {
    throw new Error(`unsafe mutagen session name: ${name}`);
  }
}

function assertIgnore(pattern: string): void {
  if (pattern.length === 0 || pattern.length > 200 || pattern.includes('\n') || pattern.includes('\0')) {
    throw new Error('unsafe mutagen ignore pattern');
  }
}

export function sessionName(project: string, userId: string, workerId?: string): string {
  const parts = [project, userId];
  if (workerId) parts.push(workerId);
  const raw = `testbox-${parts.join('-')}`.replace(/[^A-Za-z0-9-]+/g, '-');
  const name = raw.slice(0, 80).replace(/-+$/, '');
  assertSessionName(name);
  return name;
}

export function buildMutagenCreateArgs(input: {
  name: string;
  source: string;
  destination: string;
  ignore: readonly string[];
}): string[] {
  assertSessionName(input.name);
  if (input.source.includes('\n') || input.destination.includes('\n')) {
    throw new Error('unsafe mutagen path');
  }
  const args = ['sync', 'create', `--name=${input.name}`, '--sync-mode=one-way-replica'];
  for (const pattern of input.ignore) {
    assertIgnore(pattern);
    args.push(`--ignore=${pattern}`);
  }
  args.push(input.source, input.destination);
  return args;
}

export function buildMutagenFlushArgs(name: string): string[] {
  assertSessionName(name);
  return ['sync', 'flush', name];
}

export function buildMutagenPauseArgs(name: string): string[] {
  assertSessionName(name);
  return ['sync', 'pause', name];
}

export function buildMutagenResumeArgs(name: string): string[] {
  assertSessionName(name);
  return ['sync', 'resume', name];
}

export function buildMutagenTerminateArgs(name: string): string[] {
  assertSessionName(name);
  return ['sync', 'terminate', name];
}

/** One entry of `mutagen sync list --template '{{json .}}'` (Mutagen 0.18). */
export interface MutagenSessionInfo {
  name: string;
  /** The local root. Testbox always syncs from a local path. */
  alphaPath: string;
  /** The destination as `[user@]host[:port]:path`, or a plain path when it is local. */
  betaUrl: string;
  /** For example `watching`, `disconnected`, or `halted-on-root-deletion`. */
  status: string;
  paused: boolean;
}

interface MutagenUrlJson {
  user?: string;
  host?: string;
  port?: number;
  path?: string;
}

function formatMutagenUrl(url: MutagenUrlJson | undefined): string {
  if (!url) return '';
  const target = url.path ?? '';
  if (!url.host) return target;
  const user = url.user ? `${url.user}@` : '';
  const port = url.port ? `:${url.port}` : '';
  return `${user}${url.host}${port}:${target}`;
}

export function buildMutagenListArgs(): string[] {
  return ['sync', 'list', '--template', '{{json .}}'];
}

/** Parse the output of the command from buildMutagenListArgs. */
export function parseMutagenSessions(json: string): MutagenSessionInfo[] {
  const text = json.trim();
  if (text === '' || text === 'null') return [];
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error('mutagen sync list did not return a JSON array');
  return raw.map((entry) => {
    const session = entry as {
      name?: string;
      alpha?: MutagenUrlJson;
      beta?: MutagenUrlJson;
      status?: string;
      paused?: boolean;
    };
    return {
      name: session.name ?? '',
      alphaPath: session.alpha?.path ?? '',
      betaUrl: formatMutagenUrl(session.beta),
      status: session.status ?? '',
      paused: Boolean(session.paused),
    };
  });
}
