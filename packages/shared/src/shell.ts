/** Quote a single remote-shell argument. The value is never interpolated raw. */
export function quoteShellArg(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('shell argument contains a newline or NUL');
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function assertSafeHost(host: string): void {
  if (!/^[A-Za-z0-9_.:@-]+$/.test(host)) {
    throw new Error(`unsafe ssh host: ${host}`);
  }
}

/**
 * Build argv for OpenSSH. The remote command is one argument after `--`.
 * sshd joins that into a string and runs it with the user shell, so the
 * command itself must already be quoted via {@link remoteBash}.
 */
export function buildSshArgs(host: string, remoteCommand: string, identityFile?: string): string[] {
  assertSafeHost(host);
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (identityFile) {
    if (identityFile.includes('\0') || identityFile.includes('\n')) {
      throw new Error('unsafe identity file');
    }
    args.push('-i', identityFile, '-o', 'IdentitiesOnly=yes');
  }
  args.push(host, '--', remoteCommand);
  return args;
}

/**
 * Remote command string that runs `command` as a single argv to `bash -c`.
 * Optional cwd is applied with a quoted `cd` before exec. Nothing the user
 * typed is concatenated outside of quotes.
 */
export function remoteBash(command: string, cwd?: string): string {
  const execUser = `exec bash -c ${quoteShellArg(command)}`;
  const script = cwd ? `cd ${quoteShellArg(cwd)} && ${execUser}` : execUser;
  return `bash -c ${quoteShellArg(script)}`;
}

/** Local execution. `command` is one argv element, not a concatenated shell line. */
export function buildShellSpawn(command: string): { file: string; args: string[] } {
  if (command.includes('\0')) throw new Error('command contains NUL');
  return { file: 'bash', args: ['-c', command] };
}

/**
 * Build a remote shell command that `cd`s under `$HOME` and runs `command`
 * as a single argv to an inner `bash -c`. Path segments are restricted so
 * they cannot break out of the double quotes around `$HOME/...`.
 */
export function remoteHomeScript(homeRelative: string, command: string): string {
  const segments = homeRelative.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error('empty remote path');
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) throw new Error(`unsafe remote path segment: ${segment}`);
  }
  const script = `cd "$HOME/${segments.join('/')}" && exec bash -c ${quoteShellArg(command)}`;
  return `bash -c ${quoteShellArg(script)}`;
}

export function buildArgvSpawn(argv: string[]): { file: string; args: string[] } {
  if (argv.length === 0) throw new Error('empty argv');
  for (const arg of argv) {
    if (arg.includes('\0')) throw new Error('argv contains NUL');
  }
  return { file: argv[0], args: argv.slice(1) };
}
