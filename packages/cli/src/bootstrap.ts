import { readFile } from 'fs/promises';
import path from 'path';
import { buildSshArgs, quoteShellArg } from '@testbox/shared';
import type { RemoteRunner } from './remote';

/** `deploy/bootstrap` in the checkout that this CLI runs from (src/ and dist/ are at the same depth). */
export function bootstrapDir(): string {
  return path.resolve(__dirname, '..', '..', '..', 'deploy', 'bootstrap');
}

export function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * One stream for `bash -s`: exported inputs, then lib.sh, then the script.
 * Inputs travel on stdin, not argv, so a secret never shows in `ps` on the host.
 */
export async function composeScript(name: string, env: Record<string, string>, dir = bootstrapDir()): Promise<string> {
  const header = Object.entries(env).map(([key, value]) => {
    if (!/^TB_[A-Z0-9_]+$/.test(key)) throw new Error(`invalid bootstrap variable ${key}`);
    return `export ${key}=${quoteShellArg(value)}`;
  });
  const lib = await readFile(path.join(dir, 'lib.sh'), 'utf8');
  const body = await readFile(path.join(dir, `${name}.sh`), 'utf8');
  return [...header, lib, body].join('\n');
}

/** The script's last `TESTBOX_RESULT <json>` line. */
export function parseResult<T>(stdout: string): T {
  const line = stdout
    .split('\n')
    .reverse()
    .find((entry) => entry.startsWith('TESTBOX_RESULT '));
  if (!line) throw new BootstrapError('the setup script printed no result');
  return JSON.parse(line.slice('TESTBOX_RESULT '.length)) as T;
}

/** Last `error:` line, or the last two lines of stderr, so the user sees why. */
export function failureReason(stderr: string, fallback: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const error = [...lines].reverse().find((line) => line.startsWith('error: '));
  if (error) return error.slice('error: '.length);
  return lines.slice(-2).join(' / ') || fallback;
}

export async function runBootstrap<T>(opts: {
  runner: RemoteRunner;
  sshHost: string;
  script: string;
  env: Record<string, string>;
  identityFile?: string;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}): Promise<T> {
  const input = await composeScript(opts.script, opts.env);
  let pending = '';
  const result = await opts.runner.run('ssh', buildSshArgs(opts.sshHost, 'bash -s', opts.identityFile), {
    input,
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
    onStderr: (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) opts.onProgress?.(line);
    },
  });
  if (pending.trim()) opts.onProgress?.(pending);
  if (result.timedOut) throw new BootstrapError(`${opts.script} timed out on ${opts.sshHost}`);
  if (result.code === 255 && !result.stdout) {
    throw new BootstrapError(`cannot ssh to ${opts.sshHost}: ${failureReason(result.stderr, 'ssh failed')}`);
  }
  if (result.code !== 0) {
    throw new BootstrapError(
      `${opts.script} failed on ${opts.sshHost}: ${failureReason(result.stderr, `exit ${result.code}`)}`,
    );
  }
  return parseResult<T>(result.stdout);
}

/** The host part of `user@host`, when it is an IPv4 address. */
export function ipFromSshHost(sshHost: string): string | null {
  const host = sshHost.includes('@') ? sshHost.slice(sshHost.lastIndexOf('@') + 1) : sshHost;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
}
