import { EventEmitter } from 'events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/main';
import type { CommandResult, RemoteRunner } from '../src/remote';

/**
 * What a caller that reads the CLI by machine (a coding agent) relies on:
 * one summary line at the end of --json, exit 2 for mistakes in the call,
 * a workspace that starts itself, and the job log on disk.
 */

type Line = { type: string; line?: string; state?: string; exit?: number; hint?: string; logFile?: string; error?: string };

function io(home: string, cwd: string, remote: RemoteRunner, stdout: string[], stderr: string[], fetchImpl?: typeof fetch) {
  return {
    homeDir: home,
    cwd,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    remote,
    isTTY: false,
    signals: new EventEmitter(),
    prompt: async () => 'c',
    fetchImpl: fetchImpl ?? ((async () => new Response('{}', { status: 200 })) as typeof fetch),
  };
}

function jsonLines(stdout: string[]): Line[] {
  return stdout.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
}

const quietRemote: RemoteRunner = {
  async run(file, args): Promise<CommandResult> {
    if (file === 'mutagen' && args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
    const command = args.at(-1) ?? '';
    if (command.includes('snapshot-cli')) {
      return { code: 0, stdout: `${JSON.stringify({ digest: 'ab'.repeat(32), relPath: 'snapshots/snap' })}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  },
};

async function loggedIn(home: string): Promise<void> {
  await mkdir(path.join(home, '.config', 'testbox'), { recursive: true });
  await writeFile(
    path.join(home, '.config', 'testbox', 'config.json'),
    JSON.stringify({ apiUrl: 'http://api.test', token: 'user-token-123456', remoteRoot: '~/testbox' }),
  );
}

/** An API with one worker, that accepts a workspace and a job, and streams two log lines. */
function fakeApi(seen: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    seen.push(`${method} ${new URL(url).pathname}`);
    if (url.endsWith('/workspaces') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'ws_new', project: 'demo', stagingRel: 'workspaces/usr_1/demo/ws_new' }), { status: 201 });
    }
    if (url.includes('/workers/select')) {
      return new Response(JSON.stringify({ worker: { id: 'mac-1', sshHost: 'dev@10.0.0.5', labels: ['macos'] } }), { status: 200 });
    }
    if (url.endsWith('/snapshots')) return new Response(JSON.stringify({ id: 'snap', digest: 'ab'.repeat(32) }), { status: 201 });
    if (url.endsWith('/jobs') && method === 'POST') {
      return new Response(JSON.stringify({ job: { id: 'job_9', state: 'queued', exitCode: null, error: null }, superseded: [] }), { status: 201 });
    }
    if (url.endsWith('/events')) {
      return new Response(
        'event: log\ndata: {"stream":"stdout","line":"1 passed","offset":1}\n\n' +
          'event: log\ndata: {"stream":"stderr","line":"warn: slow","offset":2}\n\n' +
          'event: done\ndata: {"state":"succeeded","exitCode":0,"error":null}\n\n',
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

describe('agent-facing cli', () => {
  it('exits 2 and names the profiles when the profile is unknown, and when testbox.yml is missing or invalid', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await loggedIn(home);
      expect(await runCli(['verify', 'unit', '--json'], io(home, project, quietRemote, stdout, stderr))).toBe(2);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', state: 'error', exit: 2 });
      expect(jsonLines(stdout).at(-1)?.error).toContain('testbox.yml not found');

      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n  lint:\n    cmd: pnpm lint\n');
      stdout.length = 0;
      expect(await runCli(['verify', 'nope', '--json'], io(home, project, quietRemote, stdout, stderr))).toBe(2);
      const summary = jsonLines(stdout).at(-1);
      expect(summary).toMatchObject({ type: 'summary', state: 'error', exit: 2 });
      expect(summary?.error).toContain('unknown profile nope; the profiles in');
      expect(summary?.error).toContain('unit, lint');
      expect(summary?.hint).toContain('not the code');

      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles: [\n');
      stdout.length = 0;
      expect(await runCli(['verify', 'unit', '--json'], io(home, project, quietRemote, stdout, stderr))).toBe(2);
      expect(jsonLines(stdout).at(-1)?.error).toContain('invalid testbox.yml');

      stdout.length = 0;
      expect(await runCli(['verify', '--json'], io(home, project, quietRemote, stdout, stderr))).toBe(2);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', exit: 2 });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('ends every --json failure with a summary line that carries the exit code and a hint', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
      expect(await runCli(['verify', 'unit', '--json'], io(home, project, quietRemote, stdout, stderr))).toBe(20);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', state: 'error', error: 'not logged in', exit: 20 });
      expect(jsonLines(stdout).at(-1)?.hint).toContain('testbox setup');

      stdout.length = 0;
      expect(await runCli(['doctor', '--json'], io(home, project, quietRemote, stdout, stderr))).toBe(20);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', ok: false, exit: 20 });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('starts the workspace itself when verify runs in a checkout without one', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const seen: string[] = [];
    try {
      await loggedIn(home);
      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
      expect(await runCli(['verify', 'unit', '--json'], io(home, project, quietRemote, stdout, stderr, fakeApi(seen)))).toBe(0);
      expect(seen).toContain('POST /v1/workspaces');
      const state = JSON.parse(await readFile(path.join(project, '.testbox', 'workspace.json'), 'utf8')) as { id: string; configDir: string };
      expect(state.id).toBe('ws_new');
      expect(state.configDir).toBe(project);
      const lines = jsonLines(stdout);
      expect(lines.some((line) => line.type === 'info' && line.line?.includes('starting one'))).toBe(true);
      expect(lines.at(-1)).toMatchObject({ type: 'summary', state: 'succeeded', exit: 0 });

      // A second run reuses the workspace: no new one is made.
      seen.length = 0;
      expect(await runCli(['verify', 'unit', '--json'], io(home, project, quietRemote, stdout, stderr, fakeApi(seen)))).toBe(0);
      expect(seen).not.toContain('POST /v1/workspaces');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('writes the job log to .testbox/logs and hides it from stdout with --quiet', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await loggedIn(home);
      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
      expect(await runCli(['verify', 'unit', '--json', '--quiet'], io(home, project, quietRemote, stdout, stderr, fakeApi([])))).toBe(0);
      const lines = jsonLines(stdout);
      expect(lines.some((line) => line.type === 'log')).toBe(false);
      const summary = lines.at(-1);
      const logFile = path.join(project, '.testbox', 'logs', 'job_9.log');
      expect(summary).toMatchObject({ type: 'summary', state: 'succeeded', exit: 0, logFile });
      expect(summary?.hint).toBeUndefined();
      expect(await readFile(logFile, 'utf8')).toBe('1 passed\nwarn: slow\n');

      stdout.length = 0;
      expect(await runCli(['verify', 'unit', '--json'], io(home, project, quietRemote, stdout, stderr, fakeApi([])))).toBe(0);
      expect(jsonLines(stdout).filter((line) => line.type === 'log')).toHaveLength(2);
      expect(jsonLines(stdout).at(-1)?.logFile).toBe(logFile);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('lists the profiles of testbox.yml as text and as JSON', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await writeFile(
        path.join(project, 'testbox.yml'),
        'project: demo\nprofiles:\n  unit:\n    command: pnpm test\n  ios:\n    cmd: xcodebuild test\n    requires: [macos, xcode]\n    artifacts: ["*.xcresult/**"]\n    links: [api]\n',
      );
      const sub = path.join(project, 'packages', 'app');
      await mkdir(sub, { recursive: true });
      expect(await runCli(['profiles'], io(home, sub, quietRemote, stdout, stderr))).toBe(0);
      expect(stdout.join('')).toBe('unit: pnpm test\nios [macos, xcode]: xcodebuild test\n');
      expect(stderr.join('')).toContain(path.join(project, 'testbox.yml'));

      stdout.length = 0;
      expect(await runCli(['profiles', '--json'], io(home, sub, quietRemote, stdout, stderr))).toBe(0);
      const lines = jsonLines(stdout) as (Line & { profiles?: unknown; file?: string })[];
      expect(lines[0]).toMatchObject({
        type: 'profiles',
        file: path.join(project, 'testbox.yml'),
        project: 'demo',
        profiles: [
          { name: 'unit', command: 'pnpm test', requires: [], artifacts: [], links: [] },
          { name: 'ios', command: 'xcodebuild test', requires: ['macos', 'xcode'], artifacts: ['*.xcresult/**'], links: ['api'] },
        ],
      });
      expect(lines.at(-1)).toMatchObject({ type: 'summary', ok: true, exit: 0 });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('init adds .testbox/ to .gitignore once', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'tb-init-'));
    const out: string[] = [];
    try {
      await writeFile(path.join(repo, '.gitignore'), 'node_modules');
      expect(await runCli(['init'], io(repo, repo, quietRemote, out, out))).toBe(0);
      expect(await readFile(path.join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n.testbox/\n');
      expect(out.join('')).toContain('added .testbox/ to .gitignore');

      out.length = 0;
      expect(await runCli(['init', '--force'], io(repo, repo, quietRemote, out, out))).toBe(0);
      expect(await readFile(path.join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n.testbox/\n');
      expect(out.join('')).not.toContain('added .testbox/');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/** fakeApi, but the event stream stays open until the CLI aborts it. `onStream` runs once the stream is open. */
function openStreamApi(seen: string[], onStream: () => void): typeof fetch {
  const api = fakeApi(seen);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/events')) return api(input, init);
    seen.push(`GET ${new URL(url).pathname}`);
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: log\ndata: {"stream":"stdout","line":"building","offset":1}\n\n'));
        signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      },
    });
    setTimeout(onStream, 0);
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe('agent-facing cli: detach and run --profile', () => {
  it('detaches on SIGTERM and SIGHUP: exit 0, the job id and a hint, and the job is not cancelled', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stderr: string[] = [];
    try {
      await loggedIn(home);
      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
      for (const signal of ['SIGTERM', 'SIGHUP']) {
        const stdout: string[] = [];
        const seen: string[] = [];
        const cli = io(home, project, quietRemote, stdout, stderr);
        cli.fetchImpl = openStreamApi(seen, () => cli.signals.emit(signal));
        expect(await runCli(['verify', 'unit', '--json', '--quiet'], cli)).toBe(0);
        expect(jsonLines(stdout).at(-1)).toMatchObject({
          type: 'summary',
          jobId: 'job_9',
          state: 'detached',
          exitCode: null,
          exit: 0,
          logFile: path.join(project, '.testbox', 'logs', 'job_9.log'),
          hint: 'the job continues on the worker: testbox logs job_9 --follow, or testbox status job_9',
        });
        expect(seen).toContain('GET /v1/jobs/job_9/events');
        expect(seen.some((request) => request.endsWith('/cancel'))).toBe(false);
        expect(cli.signals.listenerCount(signal)).toBe(0);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('gives the --detach summary the same hint', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const seen: string[] = [];
    try {
      await loggedIn(home);
      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
      expect(await runCli(['verify', 'unit', '--json', '--detach'], io(home, project, quietRemote, stdout, [], fakeApi(seen)))).toBe(0);
      expect(jsonLines(stdout).at(-1)).toMatchObject({
        type: 'summary',
        jobId: 'job_9',
        state: 'detached',
        exitCode: null,
        exit: 0,
        hint: 'the job continues on the worker: testbox logs job_9 --follow, or testbox status job_9',
      });
      expect(seen.some((request) => request.endsWith('/events'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('run --profile sends the profile requires and artifacts with the custom command, and exits 2 for an unknown profile', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const seen: string[] = [];
    const jobs: unknown[] = [];
    try {
      await loggedIn(home);
      await writeFile(
        path.join(project, 'testbox.yml'),
        'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n    requires: [linux]\n    artifacts: ["coverage/**"]\n  lint:\n    cmd: pnpm lint\n',
      );
      const api = fakeApi([]);
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/jobs') && init?.method === 'POST') jobs.push(JSON.parse(String(init.body)));
        return api(input, init);
      }) as typeof fetch;
      expect(await runCli(['run', 'pnpm test -- one', '--profile', 'unit', '--json'], io(home, project, quietRemote, stdout, [], fetchImpl))).toBe(0);
      expect(jobs[0]).toMatchObject({ command: 'pnpm test -- one', profile: 'unit', requires: ['linux'], artifactGlobs: ['coverage/**'] });

      stdout.length = 0;
      seen.length = 0;
      expect(await runCli(['run', 'pnpm test', '--profile', 'nope', '--json'], io(home, project, quietRemote, stdout, [], fakeApi(seen)))).toBe(2);
      const summary = jsonLines(stdout).at(-1);
      expect(summary).toMatchObject({ type: 'summary', state: 'error', exit: 2 });
      expect(summary?.error).toContain('unknown profile nope; the profiles in');
      expect(summary?.error).toContain('unit, lint');
      expect(seen).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe('agent-facing cli: the summary contract on every path', () => {
  it('validates --timeout before any network call and exits 2', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const seen: string[] = [];
    try {
      await loggedIn(home);
      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
      expect(await runCli(['verify', 'unit', '--json', '--timeout', 'soon'], io(home, project, quietRemote, stdout, stderr, fakeApi(seen)))).toBe(2);
      expect(seen).toEqual([]);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', state: 'error', exit: 2 });
      expect(jsonLines(stdout).at(-1)?.error).toContain('invalid --timeout');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('keeps the job result when the log file cannot be written', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await loggedIn(home);
      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
      // A file where the logs directory must be: mkdir fails, and so does the open.
      await mkdir(path.join(project, '.testbox'), { recursive: true });
      await writeFile(path.join(project, '.testbox', 'logs'), 'not a directory');
      expect(await runCli(['verify', 'unit', '--json'], io(home, project, quietRemote, stdout, stderr, fakeApi([])))).toBe(0);
      const lines = jsonLines(stdout);
      expect(lines.filter((line) => line.type === 'log')).toHaveLength(2);
      expect(lines.some((line) => line.type === 'info' && line.line?.startsWith('cannot write'))).toBe(true);
      expect(lines.at(-1)).toMatchObject({ type: 'summary', state: 'succeeded', exit: 0 });
      expect(lines.at(-1)?.logFile).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('starts the first workspace on the worker that has the profile labels', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const selects: string[][] = [];
    const sshHosts: string[] = [];
    try {
      await loggedIn(home);
      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  ios:\n    cmd: xcodebuild test\n    requires: [macos, xcode]\n');
      const api = fakeApi([]);
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/workers/select')) selects.push((JSON.parse(String(init?.body)) as { requires: string[] }).requires);
        return api(input, init);
      }) as typeof fetch;
      const remote: RemoteRunner = {
        async run(file, args) {
          if (file === 'ssh') sshHosts.push(args.find((arg) => arg.includes('@')) ?? '');
          return quietRemote.run(file, args);
        },
      };
      expect(await runCli(['verify', 'ios', '--json'], io(home, project, remote, stdout, stderr, fetchImpl))).toBe(0);
      expect(selects[0]).toEqual(['macos', 'xcode']);
      expect(new Set(sshHosts)).toEqual(new Set(['dev@10.0.0.5']));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('ends doctor, init, prune, status, and logs with a summary that has exit', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await loggedIn(home);
      // doctor: the API answers the health check, then fails on an unexpected error.
      const broken = (async (input: string | URL | Request) => {
        if (String(input).endsWith('/healthz')) return new Response('{}', { status: 200 });
        throw new Error('socket hang up');
      }) as typeof fetch;
      expect(await runCli(['doctor', '--json'], io(home, project, quietRemote, stdout, stderr, broken))).toBe(1);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', state: 'error', error: 'socket hang up', exit: 1 });

      stdout.length = 0;
      expect(await runCli(['init', '--json'], io(home, project, quietRemote, stdout, stderr))).toBe(0);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', ok: true, exit: 0, file: path.join(project, 'testbox.yml') });
      expect(stderr.join('')).not.toContain('testbox start');

      stdout.length = 0;
      expect(await runCli(['prune', '--dry-run', '--json'], io(home, project, quietRemote, stdout, stderr))).toBe(0);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', ok: true, exit: 0, count: 0, dryRun: true });

      const jobApi = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/logs')) return new Response(JSON.stringify({ lines: [{ stream: 'stdout', line: 'boom' }] }), { status: 200 });
        if (url.endsWith('/events')) return new Response('event: done\ndata: {"state":"failed","exitCode":1,"error":null}\n\n', { status: 200 });
        return new Response(JSON.stringify({ job: { id: 'job_7', state: 'failed', exitCode: 1, error: null } }), { status: 200 });
      }) as typeof fetch;
      stdout.length = 0;
      expect(await runCli(['status', 'job_7', '--json'], io(home, project, quietRemote, stdout, stderr, jobApi))).toBe(1);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', jobId: 'job_7', state: 'failed', exitCode: 1, exit: 1 });
      expect(jsonLines(stdout).at(-1)?.hint).toContain('fix the code');

      stdout.length = 0;
      expect(await runCli(['logs', 'job_7', '--json'], io(home, project, quietRemote, stdout, stderr, jobApi))).toBe(1);
      expect(jsonLines(stdout)[0]).toMatchObject({ type: 'log', line: 'boom' });
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', exit: 1 });

      // logs --follow inside the repo writes the file too.
      stdout.length = 0;
      expect(await runCli(['logs', 'job_7', '--follow', '--json'], io(home, project, quietRemote, stdout, stderr, jobApi))).toBe(1);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', exit: 1, logFile: path.join(project, '.testbox', 'logs', 'job_7.log') });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

/** A parent folder with the checkout `interface_TGN-821` (profile ios links api) and the checkouts named in `others`. */
async function linkedCheckouts(others: Record<string, string | null>): Promise<{ root: string; main: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tb-links-'));
  const main = path.join(root, 'interface_TGN-821');
  await mkdir(main);
  await writeFile(path.join(main, 'testbox.yml'), 'project: interface\nprofiles:\n  ios:\n    cmd: xcodebuild test\n    requires: [macos]\n    links: [api]\n  unit:\n    cmd: make\n');
  for (const [name, config] of Object.entries(others)) {
    await mkdir(path.join(root, name), { recursive: true });
    if (config !== null) await writeFile(path.join(root, name, 'testbox.yml'), config);
  }
  return { root, main };
}

/** fakeApi, but each project gets its own workspace, and the requests are kept with their bodies. */
function linkApi(seen: { call: string; body: unknown }[]): typeof fetch {
  const base = fakeApi([]);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    seen.push({ call: `${method} ${new URL(url).pathname}`, body });
    if (url.endsWith('/workspaces') && method === 'POST') {
      const project = (body as { project: string }).project;
      return new Response(JSON.stringify({ id: `ws_${project}`, project, stagingRel: `workspaces/usr_1/${project}/ws_${project}` }), { status: 201 });
    }
    return base(input, init);
  }) as typeof fetch;
}

/** quietRemote that keeps every call, and answers the snapshot with a work dir. */
function recordingRemote(calls: { file: string; args: string[] }[]): RemoteRunner {
  return {
    async run(file, args) {
      calls.push({ file, args });
      if ((args.at(-1) ?? '').includes('snapshot-cli')) {
        return { code: 0, stdout: `${JSON.stringify({ digest: 'ab'.repeat(32), relPath: 'snapshots/snap', workDir: 'interface' })}\n`, stderr: '' };
      }
      return quietRemote.run(file, args);
    },
  };
}

describe('agent-facing cli: links', () => {
  it('syncs the sibling checkout <link>_<suffix> to the same worker and snapshots it next to this tree', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const { root, main } = await linkedCheckouts({ 'api_TGN-821': 'project: api\nignore: [secret.txt]\n', api: 'project: api\n' });
    const stdout: string[] = [];
    const seen: { call: string; body: unknown }[] = [];
    const calls: { file: string; args: string[] }[] = [];
    try {
      await loggedIn(home);
      expect(await runCli(['verify', 'ios', '--json'], io(home, main, recordingRemote(calls), stdout, [], linkApi(seen)))).toBe(0);
      const created = seen.filter((entry) => entry.call === 'POST /v1/workspaces').map((entry) => entry.body);
      expect(created).toEqual([{ project: 'interface' }, { project: 'api' }]);
      const apiDir = path.join(root, 'api_TGN-821');
      const linkState = JSON.parse(await readFile(path.join(apiDir, '.testbox', 'workspace.json'), 'utf8')) as { id: string; workerId: string };
      expect(linkState).toMatchObject({ id: 'ws_api', workerId: 'mac-1' });

      const snapshot = calls.find((entry) => (entry.args.at(-1) ?? '').includes('snapshot-cli'))?.args.at(-1) ?? '';
      expect(snapshot).toContain('--staging-rel');
      expect(snapshot).toContain('workspaces/usr_1/interface/ws_interface');
      expect(snapshot).toMatch(/--work-dir '\\''interface'\\''/);
      expect(snapshot).toMatch(/--link '\\''api=workspaces\/usr_1\/api\/ws_api'\\''/);
      expect(snapshot).toMatch(/--link-ignore '\\''api=secret.txt'\\''/);
      // Both sessions are paused for the snapshot and resumed after it.
      const mutagen = (verb: string) => calls.filter((entry) => entry.file === 'mutagen' && entry.args[1] === verb).map((entry) => entry.args[2]);
      expect(mutagen('pause')).toHaveLength(2);
      expect(new Set(mutagen('resume'))).toEqual(new Set(mutagen('pause')));
      expect(mutagen('flush')).toHaveLength(2);

      expect(seen.find((entry) => entry.call.endsWith('/snapshots'))?.body).toMatchObject({ workDir: 'interface' });
      const lines = jsonLines(stdout) as (Line & { links?: unknown })[];
      const source = lines.find((line) => line.type === 'source');
      expect(source?.links).toEqual([{ name: 'api', path: apiDir, dirty: false }]);
      expect((seen.find((entry) => entry.call === 'POST /v1/jobs')?.body as { source: unknown }).source).toMatchObject({ links: [{ name: 'api', path: apiDir }] });
      expect(lines.at(-1)).toMatchObject({ type: 'summary', state: 'succeeded', exit: 0 });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exits 2 before any network call when a link has no checkout or no testbox.yml', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const { root, main } = await linkedCheckouts({});
    const stdout: string[] = [];
    const seen: { call: string; body: unknown }[] = [];
    try {
      await loggedIn(home);
      expect(await runCli(['verify', 'ios', '--json'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(2);
      expect(jsonLines(stdout).at(-1)).toMatchObject({
        type: 'summary',
        exit: 2,
        error: 'link api: no checkout at ../api_TGN-821 or ../api; pass --link api=<path>',
      });

      await mkdir(path.join(root, 'api'));
      stdout.length = 0;
      expect(await runCli(['verify', 'ios', '--json'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(2);
      expect(jsonLines(stdout).at(-1)?.error).toBe(`link api: ${path.join(root, 'api')} has no testbox.yml; run testbox init there`);
      expect(seen).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the --link path, rejects a --link the profile does not have, and rejects --direct with links', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const { root, main } = await linkedCheckouts({ 'elsewhere/api-fork': 'project: api\n', api: 'project: api\n' });
    const stdout: string[] = [];
    const seen: { call: string; body: unknown }[] = [];
    try {
      await loggedIn(home);
      expect(await runCli(['verify', 'ios', '--json', '--link', 'api=../elsewhere/api-fork'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(0);
      const source = (jsonLines(stdout) as (Line & { links?: { path: string }[] })[]).find((line) => line.type === 'source');
      expect(source?.links?.[0]?.path).toBe(path.join(root, 'elsewhere', 'api-fork'));

      stdout.length = 0;
      seen.length = 0;
      expect(await runCli(['verify', 'ios', '--json', '--link', 'web=../api'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(2);
      expect(jsonLines(stdout).at(-1)?.error).toBe('--link web: profile ios has no link web; its links are: api');

      stdout.length = 0;
      expect(await runCli(['verify', 'ios', '--json', '--link', 'api=../nope'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(2);
      expect(jsonLines(stdout).at(-1)?.error).toBe('link api: no checkout at ../nope; fix the path of --link');

      stdout.length = 0;
      expect(await runCli(['verify', 'ios', '--json', '--direct'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(2);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', exit: 2, error: 'links need the control plane; run without --direct' });
      expect(seen).toEqual([]);

      // run takes its links from --link only.
      stdout.length = 0;
      expect(await runCli(['run', 'make', '--json', '--link', 'api=../api'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(0);
      const runSource = (jsonLines(stdout) as (Line & { links?: { name: string; path: string }[] })[]).find((line) => line.type === 'source');
      expect(runSource?.links).toMatchObject([{ name: 'api', path: path.join(root, 'api') }]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('gives run --profile the links of the profile, and rejects a bad, repeated, self, or project-named --link with exit 2', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const { root, main } = await linkedCheckouts({ api: 'project: api\n' });
    const stdout: string[] = [];
    const seen: { call: string; body: unknown }[] = [];
    try {
      await loggedIn(home);
      expect(await runCli(['run', 'xcodebuild test -only-testing:One', '--profile', 'ios', '--json'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(0);
      const source = (jsonLines(stdout) as (Line & { links?: { name: string }[] })[]).find((line) => line.type === 'source');
      expect(source?.links).toMatchObject([{ name: 'api' }]);
      expect(seen.find((entry) => entry.call === 'POST /v1/jobs')?.body).toMatchObject({
        command: 'xcodebuild test -only-testing:One',
        profile: 'ios',
        requires: ['macos'],
        source: { links: [{ name: 'api', path: path.join(root, 'api') }] },
      });

      const bad = async (args: string[], error: string) => {
        stdout.length = 0;
        seen.length = 0;
        expect(await runCli([...args, '--json'], io(home, main, quietRemote, stdout, [], linkApi(seen)))).toBe(2);
        expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', exit: 2, error });
        expect(seen).toEqual([]);
      };
      await bad(['run', 'make', '--link', 'api'], 'invalid --link api: pass --link <name>=<path>');
      await bad(['run', 'make', '--link', 'api=../api', '--link', 'api=../api'], '--link api is given twice');
      await bad(['run', 'make', '--link', 'api=.'], `link api: ${main} is this checkout`);
      await bad(['run', 'make', '--link', 'interface=../api'], '--link interface: a link cannot have the project name interface');
      const many = Array.from({ length: 21 }, (_, i) => ['--link', `l${i}=../api`]).flat();
      await bad(['run', 'make', ...many], '--link: at most 20 links');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes every paused session when the snapshot fails, or when a later pause fails', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const { root, main } = await linkedCheckouts({ api: 'project: api\n' });
    const stdout: string[] = [];
    const calls: { file: string; args: string[] }[] = [];
    /** quietRemote that fails one step: the snapshot, or the pause of the api session. */
    const failing = (step: 'snapshot' | 'pause-api'): RemoteRunner => ({
      async run(file, args) {
        calls.push({ file, args });
        const last = args.at(-1) ?? '';
        if (step === 'snapshot' && last.includes('snapshot-cli')) return { code: 1, stdout: '', stderr: 'rsync: disk full' };
        if (step === 'pause-api' && file === 'mutagen' && args[1] === 'pause' && args[2].includes('-api-')) {
          return { code: 1, stdout: '', stderr: 'session not found' };
        }
        return quietRemote.run(file, args);
      },
    });
    const mutagen = (verb: string) => calls.filter((entry) => entry.file === 'mutagen' && entry.args[1] === verb).map((entry) => entry.args[2]);
    try {
      await loggedIn(home);
      expect(await runCli(['verify', 'ios', '--json'], io(home, main, failing('snapshot'), stdout, [], linkApi([])))).toBe(10);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', exit: 10, error: 'rsync: disk full' });
      expect(mutagen('pause')).toHaveLength(2);
      expect(new Set(mutagen('resume'))).toEqual(new Set(mutagen('pause')));

      calls.length = 0;
      stdout.length = 0;
      expect(await runCli(['verify', 'ios', '--json'], io(home, main, failing('pause-api'), stdout, [], linkApi([])))).toBe(10);
      expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'summary', exit: 10, error: 'session not found' });
      // The main session was paused and is resumed; the api session never paused, so it is not resumed.
      expect(mutagen('pause')).toHaveLength(2);
      expect(mutagen('resume')).toEqual([mutagen('pause')[0]]);
      expect(calls.some((entry) => (entry.args.at(-1) ?? '').includes('snapshot-cli'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
