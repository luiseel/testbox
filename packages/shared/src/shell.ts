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

const JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The `$0` of a job shell: a marker that `ps` shows in its arguments on every platform. */
export function jobMarker(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error('unsafe job id');
  return `testbox-job:${jobId}`;
}

/** True when `ps` output (arguments or environment) carries the marker of this job. */
export function commandLineHasJob(psOutput: string, jobId: string): boolean {
  const marker = jobMarker(jobId);
  return psOutput.split(/\s+/).includes(marker) || psOutput.split(/\s+/).includes(`TESTBOX_JOB_ID=${jobId}`);
}

/**
 * Local execution. `command` is one argv element, not a concatenated shell line.
 * With a job id, `$0` is the job marker and `exit "$?"` ends the script, so bash
 * stays the group leader instead of exec-ing a single last command. macOS hides
 * the environment of system binaries from `ps`, but never their arguments; the
 * orphan reaper reads the marker from there.
 */
export function buildShellSpawn(command: string, jobId?: string): { file: string; args: string[] } {
  if (command.includes('\0')) throw new Error('command contains NUL');
  if (jobId === undefined) return { file: 'bash', args: ['-c', command] };
  return { file: 'bash', args: ['-c', `${command}\nexit "$?"`, jobMarker(jobId)] };
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
