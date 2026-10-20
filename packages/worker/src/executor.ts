import { spawn, execFile } from 'child_process';
import { open } from 'fs/promises';
import { promisify } from 'util';
import { buildArgvSpawn, buildShellSpawn, commandLineHasJob, redact } from '@testbox/shared';

const execFileAsync = promisify(execFile);

export interface RunCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  graceMs?: number;
  abortSignal?: AbortSignal;
  onLog?: (event: { stream: 'stdout' | 'stderr'; text: string }) => void;
  onSpawn?: (pgid: number) => void;
  secrets?: readonly string[];
  shell: { command: string } | { argv: string[] };
  /** Marks the job shell for the orphan reaper. Defaults to `TESTBOX_JOB_ID` in `env`. */
  jobId?: string;
}

export interface RunCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  pgid: number;
}

export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(`refusing to signal process group ${pgid}`);
  }
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw err;
  }
}

/**
 * True when the process group leader still belongs to the job, so its pid was not
 * reused. Linux: the environment in /proc. Everywhere: the arguments and the
 * environment that `ps` shows (macOS hides the environment of system binaries).
 */
export async function processStillOwnsJob(pgid: number, jobId: string): Promise<boolean> {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (process.platform === 'linux') {
    const env = await readProcEnviron(pgid);
    if (env === null) return false;
    if (env.length > 0 && env.includes(`TESTBOX_JOB_ID=${jobId}`)) return true;
  }
  try {
    const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pgid)]);
    return commandLineHasJob(stdout, jobId);
  } catch {
    return false;
  }
}

/**
 * `/proc/<pid>/environ` is often reported as zero length. `readFile` can
 * therefore return an empty buffer, so read until EOF instead.
 */
async function readProcEnviron(pid: number): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(`/proc/${pid}/environ`, 'r');
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      total += bytesRead;
      if (total > 1024 * 1024) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

function lineWriter(
  stream: 'stdout' | 'stderr',
  secrets: readonly string[],
  onLog?: RunCommandOptions['onLog'],
): { push: (chunk: Buffer) => void; end: () => void } {
  let buf = '';
  const emit = (line: string) => onLog?.({ stream, text: redact(line, secrets) });
  return {
    push(chunk: Buffer) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const part of parts) emit(part);
    },
    end() {
      if (buf.length > 0) emit(buf);
      buf = '';
    },
  };
}

/**
 * Run a command in its own process group.
 * The command string, when used, is a single argv to `bash -c` and is never
 * concatenated into another shell line. Cancellation and timeout signal the
 * whole group, then SIGKILL after the grace period, then wait for the leader
 * so descendants are not left unreaped.
 */
export async function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const jobId = opts.jobId ?? opts.env.TESTBOX_JOB_ID;
  const spec = 'command' in opts.shell ? buildShellSpawn(opts.shell.command, jobId) : buildArgvSpawn(opts.shell.argv);
  const child = spawn(spec.file, spec.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pgid = child.pid;
  if (!pgid || pgid <= 1) {
    child.kill('SIGKILL');
    throw new Error('failed to start a process group');
  }
  opts.onSpawn?.(pgid);

  const graceMs = opts.graceMs ?? 2_000;
  const stdout = lineWriter('stdout', opts.secrets ?? [], opts.onLog);
  const stderr = lineWriter('stderr', opts.secrets ?? [], opts.onLog);
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  let killReason: 'timeout' | 'cancel' | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  const kill = (reason: 'timeout' | 'cancel') => {
    if (killReason) return;
    killReason = reason;
    killProcessGroup(pgid, 'SIGTERM');
    killTimer = setTimeout(() => {
      killProcessGroup(pgid, 'SIGKILL');
    }, graceMs);
  };

  const onAbort = () => {
    const reason = opts.abortSignal?.reason;
    kill(reason === 'cancel' ? 'cancel' : 'timeout');
  };
  if (opts.abortSignal?.aborted) onAbort();
  else opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', (err) => reject(err));
    child.once('exit', (code, signal) => {
      // The leader's pid is the process group id. Reap descendants before
      // that id can be reused by an unrelated process.
      try {
        killProcessGroup(pgid, 'SIGKILL');
      } catch {
        // group already gone
      }
      resolve({ code, signal });
    });
  }).finally(() => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    opts.abortSignal?.removeEventListener('abort', onAbort);
    stdout.end();
    stderr.end();
  });

  return {
    exitCode: exit.code,
    signal: exit.signal,
    timedOut: killReason === 'timeout',
    cancelled: killReason === 'cancel',
    pgid,
  };
}
