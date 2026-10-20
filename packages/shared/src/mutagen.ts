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

/** Lists all sessions as one JSON array; each entry has a `name` field. */
export function buildMutagenListArgs(): string[] {
  return ['sync', 'list', '--template', '{{json .}}'];
}

export function buildMutagenTerminateArgs(name: string): string[] {
  assertSessionName(name);
  return ['sync', 'terminate', name];
}
