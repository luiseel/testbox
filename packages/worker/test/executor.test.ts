import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildJobEnv } from '../src/env';
import { collectArtifacts } from '../src/artifacts';
import { killProcessGroup, processStillOwnsJob, runCommand } from '../src/executor';

describe('executor', () => {
  it('kills the child process group on cancel', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    const bashFile = path.join(dir, 'bash.pid');
    const sleepFile = path.join(dir, 'sleep.pid');
    const abort = new AbortController();
    const pending = runCommand({
      cwd: dir,
      env: { ...process.env, TESTBOX_JOB_ID: 'job_cancel' },
      timeoutMs: 20_000,
      graceMs: 200,
      abortSignal: abort.signal,
      shell: { command: `echo $$ > ${shellQuote(bashFile)}; sleep 30 & echo $! > ${shellQuote(sleepFile)}; wait` },
    });
    await waitFor(async () => {
      const bash = await readFile(bashFile, 'utf8').catch(() => '');
      const sleepPid = await readFile(sleepFile, 'utf8').catch(() => '');
      return bash.trim().length > 0 && sleepPid.trim().length > 0;
    });
    const bashPid = Number((await readFile(bashFile, 'utf8')).trim());
    const sleepPid = Number((await readFile(sleepFile, 'utf8')).trim());
    abort.abort('cancel');
    const result = await pending;
    expect(result.cancelled).toBe(true);
    await waitFor(async () => !alive(bashPid) && !alive(sleepPid));
    expect(alive(bashPid)).toBe(false);
    expect(alive(sleepPid)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    const started = Date.now();
    const result = await runCommand({
      cwd: dir,
      env: process.env,
      timeoutMs: 300,
      graceMs: 200,
      shell: { command: `node -e 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'` },
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(alive(result.pgid)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('starts a new process group and redacts secrets from logs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    let pgid = 0;
    const logs: string[] = [];
    const result = await runCommand({
      cwd: dir,
      env: buildJobEnv(
        { ...process.env, TESTBOX_WORKER_TOKEN: 'supersecretvalue', HOME: os.homedir() },
        [],
        'job_redact',
      ),
      timeoutMs: 10_000,
      shell: { command: 'echo supersecretvalue; printf %s "$TESTBOX_WORKER_TOKEN"' },
      secrets: ['supersecretvalue'],
      onLog: (event) => logs.push(event.text),
      onSpawn: (pid) => {
        pgid = pid;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(pgid).toBeGreaterThan(1);
    const joined = logs.join('\n');
    expect(joined).toContain('[REDACTED]');
    expect(joined).not.toContain('supersecretvalue');
    expect(await processStillOwnsJob(result.pgid, 'job_redact')).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('reaps an orphan only when it still belongs to the job', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    let pgid = 0;
    const child = runCommand({
      cwd: dir,
      env: buildJobEnv(process.env, [], 'job_orphan'),
      timeoutMs: 20_000,
      shell: { command: 'sleep 30' },
      onSpawn: (pid) => {
        pgid = pid;
      },
    });
    let owns = false;
    let other = true;
    await waitFor(async () => {
      if (pgid <= 1) return false;
      owns = await processStillOwnsJob(pgid, 'job_orphan');
      other = await processStillOwnsJob(pgid, 'job_other');
      return owns && !other;
    });
    expect(owns).toBe(true);
    expect(other).toBe(false);
    killProcessGroup(pgid, 'SIGKILL');
    await child;
    expect(alive(pgid)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('reaps background descendants when the leader exits', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    const pidFile = path.join(dir, 'sleep.pid');
    const result = await runCommand({
      cwd: dir,
      env: buildJobEnv(process.env, [], 'job_bg'),
      timeoutMs: 10_000,
      shell: { command: `sleep 30 & echo $! > ${shellQuote(pidFile)}` },
    });
    expect(result.exitCode).toBe(0);
    const sleepPid = Number((await readFile(pidFile, 'utf8')).trim());
    await waitFor(() => !alive(sleepPid));
    expect(alive(sleepPid)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('artifacts', () => {
  it('collects glob matches and skips files outside the root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'art-'));
    await mkdir(path.join(root, 'out', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'out', 'nested', 'a.txt'), 'hi');
    await writeFile(path.join(root, 'skip.txt'), 'no');
    const files = await collectArtifacts(root, ['out/**'], 1024);
    expect(files.map((file) => file.relPath)).toEqual(['out/nested/a.txt']);
    await rm(root, { recursive: true, force: true });
  });
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => Promise<boolean> | boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out waiting');
}
