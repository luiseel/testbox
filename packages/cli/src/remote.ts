import { spawn } from 'child_process';
import {
  buildMutagenCreateArgs,
  buildMutagenFlushArgs,
  buildMutagenPauseArgs,
  buildMutagenResumeArgs,
  buildMutagenTerminateArgs,
  buildSshArgs,
  quoteShellArg,
  remoteBash,
  remoteHomeScript,
} from '@testbox/shared';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Written to stdin, then stdin is closed. Without it, stdin is /dev/null. */
  input?: string;
  /** Called with each stderr chunk as it arrives, for progress output. */
  onStderr?: (text: string) => void;
}

export interface RemoteRunner {
  run(file: string, args: string[], opts?: RunOptions): Promise<CommandResult>;
}

export function defaultSpawn(file: string, args: string[], opts?: RunOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: [opts?.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (opts?.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(opts.input);
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 500).unref();
        }, opts.timeoutMs)
      : null;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      opts?.onStderr?.(chunk.toString());
    });
    child.once('error', (err) => finish({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut }));
    child.once('exit', (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

export class RemoteUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteUnavailable';
  }
}

function homeRelative(remoteRoot: string, rel: string): string {
  const root = remoteRoot.replace(/^~\//, '').replace(/^\//, '');
  return `${root}/${rel}`.replace(/\/+/g, '/');
}

export class MutagenSsh {
  constructor(
    private readonly runner: RemoteRunner,
    private readonly sshHost: string,
    private readonly identityFile?: string,
  ) {}

  async create(input: { name: string; source: string; destination: string; ignore: string[] }): Promise<void> {
    const result = await this.runner.run('mutagen', buildMutagenCreateArgs(input));
    if (result.code !== 0) throw new SyncError(result.stderr || 'mutagen sync create failed');
  }

  /** Create the staging tree on the worker; Mutagen will not create a missing beta root parent. */
  async ensureStaging(remoteRoot: string, stagingRel: string): Promise<void> {
    const segments = homeRelative(remoteRoot, stagingRel).split('/').filter((segment) => segment.length > 0);
    for (const segment of segments) {
      if (!/^[A-Za-z0-9._-]+$/.test(segment)) throw new SyncError(`unsafe remote path segment: ${segment}`);
    }
    const result = await this.ssh(`mkdir -p "$HOME/${segments.join('/')}"`);
    if (result.code !== 0) throw new SyncError(result.stderr || 'failed to create staging directory');
  }

  async flush(name: string): Promise<void> {
    const result = await this.runner.run('mutagen', buildMutagenFlushArgs(name));
    if (result.code !== 0) throw new SyncError(result.stderr || 'mutagen sync flush failed');
  }

  async pause(name: string): Promise<void> {
    const result = await this.runner.run('mutagen', buildMutagenPauseArgs(name));
    if (result.code !== 0) throw new SyncError(result.stderr || 'mutagen sync pause failed');
  }

  async resume(name: string): Promise<void> {
    const result = await this.runner.run('mutagen', buildMutagenResumeArgs(name));
    if (result.code !== 0) throw new SyncError(result.stderr || 'mutagen sync resume failed');
  }

  async terminate(name: string): Promise<void> {
    const result = await this.runner.run('mutagen', buildMutagenTerminateArgs(name));
    if (result.code !== 0) throw new SyncError(result.stderr || 'mutagen sync terminate failed');
  }

  async ssh(remoteCommand: string, timeoutMs?: number): Promise<CommandResult> {
    const result = await this.runner.run('ssh', buildSshArgs(this.sshHost, remoteCommand, this.identityFile), {
      timeoutMs,
    });
    if (result.timedOut) return result;
    if (result.code === null || result.code === 255) {
      throw new RemoteUnavailable(result.stderr || 'ssh failed');
    }
    return result;
  }

  async probe(): Promise<{ nodeVersion: string | null; arch: string; platform: string; xcodeVersion: string | null }> {
    const result = await this.ssh(remoteBash(runtimeProbeScript()));
    if (result.code !== 0) throw new RemoteUnavailable(result.stderr || 'runtime probe failed');
    return JSON.parse(result.stdout) as {
      nodeVersion: string | null;
      arch: string;
      platform: string;
      xcodeVersion: string | null;
    };
  }

  async execIn(remoteRoot: string, rel: string, command: string, timeoutMs?: number): Promise<CommandResult> {
    return this.ssh(remoteHomeScript(homeRelative(remoteRoot, rel), command), timeoutMs);
  }

  async snapshot(opts: {
    remoteRoot: string;
    snapshotBin: string;
    stagingRel: string;
    snapshotId: string;
    ignore: string[];
  }): Promise<{ digest: string; relPath: string }> {
    const dataRel = opts.remoteRoot.replace(/^~\//, '');
    const binRel = opts.snapshotBin.replace(/^~\//, '');
    const args = [
      `"$HOME/${binRel}"`,
      '--data-dir',
      `"$HOME/${dataRel}"`,
      '--staging-rel',
      quoteShellArg(opts.stagingRel),
      '--snapshot-id',
      quoteShellArg(opts.snapshotId),
    ];
    for (const pattern of opts.ignore) args.push('--ignore', quoteShellArg(pattern));
    const script = `node ${args.join(' ')}`;
    const result = await this.ssh(`bash -c ${quoteShellArg(script)}`);
    if (result.code !== 0) throw new SyncError(result.stderr || 'snapshot failed');
    return JSON.parse(result.stdout) as { digest: string; relPath: string };
  }
}

/** Constant probe script. Xcode is probed only on darwin. */
export function runtimeProbeScript(): string {
  return 'node -e "let x=null;if(process.platform===\\"darwin\\"){try{x=require(\\"child_process\\").execSync(\\"xcodebuild -version\\",{encoding:\\"utf8\\"}).split(\\"\\\\n\\")[0]}catch(e){}}process.stdout.write(JSON.stringify({nodeVersion:process.version,arch:process.arch,platform:process.platform,xcodeVersion:x}))"';
}

export function mutagenDestination(sshHost: string, remoteRoot: string, stagingRel: string): string {
  const root = remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot;
  return `${sshHost}:${root}/${stagingRel}`;
}
