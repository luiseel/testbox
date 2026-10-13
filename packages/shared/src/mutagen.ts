export function assertSessionName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
    throw new Error(`unsafe mutagen session name: ${name}`);
  }
}

function assertIgnore(pattern: string): void {
  if (pattern.length === 0 || pattern.length > 200 || pattern.includes('\n') || pattern.includes('\0')) {
    throw new Error('unsafe mutagen ignore pattern');
  }
}

export function sessionName(project: string, userId: string): string {
  const raw = `testbox-${project}-${userId}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const name = raw.slice(0, 80);
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
