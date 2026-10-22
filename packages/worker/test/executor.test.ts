import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const sleepFile = path.join(dir, 'sleep.pid');
    const started = Date.now();
    // The group leader and its child ignore SIGTERM, so only the escalation can end
    // them, with or without a job id in the environment.
    const pending = runCommand({
      cwd: dir,
      env: envWithoutJob(),
      timeoutMs: 300,
      graceMs: 200,
      shell: { command: `trap '' TERM; sleep 30 & echo $! > ${shellQuote(sleepFile)}; wait` },
    });
    await waitFor(async () => (await readFile(sleepFile, 'utf8').catch(() => '')).trim().length > 0);
    const sleepPid = Number((await readFile(sleepFile, 'utf8')).trim());
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(alive(result.pgid)).toBe(false);
    await waitFor(async () => !alive(sleepPid));
    expect(alive(sleepPid)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('sends SIGTERM first and gives the job its grace period', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    const logs: string[] = [];
    const result = await runCommand({
      cwd: dir,
      env: envWithoutJob(),
      timeoutMs: 300,
      graceMs: 10_000,
      shell: { command: `trap 'echo got-term; exit 0' TERM; echo ready; while :; do sleep 0.05; done` },
      onLog: (event) => {
        // bash also reports the killed `sleep` on stderr.
        if (event.stream === 'stdout') logs.push(event.text);
      },
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(logs).toEqual(['ready', 'got-term']);
    await rm(dir, { recursive: true, force: true });
  });

  it('cancels at once when the abort signal is already aborted', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    const started = Date.now();
    const result = await runCommand({
      cwd: dir,
      env: envWithoutJob(),
      timeoutMs: 15_000,
      graceMs: 200,
      abortSignal: AbortSignal.abort('cancel'),
      shell: { command: 'sleep 30' },
    });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    await rm(dir, { recursive: true, force: true });
  });

  it('labels stderr lines as stderr', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    const events: { stream: string; text: string }[] = [];
    const result = await runCommand({
      cwd: dir,
      env: envWithoutJob(),
      timeoutMs: 10_000,
      shell: { command: 'echo out; echo err >&2' },
      onLog: (event) => events.push(event),
    });
    expect(result.exitCode).toBe(0);
    expect(events).toContainEqual({ stream: 'stdout', text: 'out' });
    expect(events).toContainEqual({ stream: 'stderr', text: 'err' });
    expect(events).toHaveLength(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps a line split across chunks whole and emits a last line without a newline', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exec-'));
    const events: { stream: string; text: string }[] = [];
    const script = 'process.stdout.write("x".repeat(200000) + "\\n" + "done")';
    const result = await runCommand({
      cwd: dir,
      env: envWithoutJob(),
      timeoutMs: 10_000,
      shell: { argv: [process.execPath, '-e', script] },
      onLog: (event) => events.push(event),
    });
    expect(result.exitCode).toBe(0);
    expect(events.map((event) => event.text.length)).toEqual([200_000, 4]);
    expect(events[0].text).toBe('x'.repeat(200_000));
    expect(events[1]).toEqual({ stream: 'stdout', text: 'done' });
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
    // macOS shows a new process's environment to ps only for a moment: look after it settles.
    await new Promise((resolve) => setTimeout(resolve, 300));
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

describe('killProcessGroup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses process group 0 and 1 without sending a signal', () => {
    // A stub: with a broken guard, process.kill(-1) would signal every process of the user.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(() => killProcessGroup(1, 'SIGTERM')).toThrow('refusing to signal process group 1');
    expect(() => killProcessGroup(0, 'SIGTERM')).toThrow('refusing to signal process group 0');
    expect(kill).not.toHaveBeenCalled();
  });

  it('ignores a group that is gone but throws on other kill errors', () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    vi.spyOn(process, 'kill').mockImplementationOnce(fail('ESRCH')).mockImplementationOnce(fail('EPERM'));
    expect(() => killProcessGroup(4242, 'SIGTERM')).not.toThrow();
    expect(() => killProcessGroup(4242, 'SIGTERM')).toThrow('EPERM');
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

function envWithoutJob(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TESTBOX_JOB_ID;
  return env;
}

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
