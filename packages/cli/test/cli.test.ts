import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { chmod, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { buildMutagenCreateArgs, buildSshArgs, remoteBash } from '@testbox/shared';
import { attachInterrupt } from '../src/interrupt';
import { runCli } from '../src/main';
import { runtimeProbeScript, type CommandResult, type RemoteRunner } from '../src/remote';

const exec = promisify(execFile);

describe('runtime probe', () => {
  it('reports node and leaves Xcode null when xcodebuild is absent', async () => {
    const { stdout } = await exec('sh', ['-c', remoteBash(runtimeProbeScript())]);
    const parsed = JSON.parse(stdout) as { nodeVersion: string; arch: string; xcodeVersion: string | null };
    expect(parsed.nodeVersion.startsWith('v')).toBe(true);
    expect(parsed.arch.length).toBeGreaterThan(0);
    expect(parsed.xcodeVersion === null || parsed.xcodeVersion.includes('Xcode')).toBe(true);
  });
});

describe('interrupt', () => {
  it('cancels immediately when there is no tty and asks on a tty', async () => {
    const signals = new EventEmitter();
    let cancelled = 0;
    let detached = 0;
    const dispose = attachInterrupt({
      signals,
      isTTY: false,
      prompt: async () => 'd',
      cancel: () => {
        cancelled += 1;
      },
      detach: () => {
        detached += 1;
      },
    });
    signals.emit('SIGINT');
    expect(cancelled).toBe(1);
    expect(detached).toBe(0);
    dispose();

    const tty = new EventEmitter();
    let prompt: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      prompt = resolve;
    });
    let ttyCancel = 0;
    let ttyDetach = 0;
    const stop = attachInterrupt({
      signals: tty,
      isTTY: true,
      prompt: () => pending,
      cancel: () => {
        ttyCancel += 1;
      },
      detach: () => {
        ttyDetach += 1;
      },
    });
    tty.emit('SIGINT');
    tty.emit('SIGINT');
    expect(ttyCancel).toBe(1);
    prompt('d');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ttyDetach).toBe(0);
    stop();
  });
});

describe('cli', () => {
  it('stores a token with mode 0600 and maps verify exit codes', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: { file: string; args: string[] }[] = [];
    const remote = fakeRemote(calls);
    try {
      const login = await runCli(['login', '--token', 'token-value-123456', '--api-url', 'http://api.test', '--ssh-host', 'testbox'], {
        homeDir: home,
        cwd: project,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: (chunk) => stderr.push(chunk) },
        remote,
        isTTY: false,
        signals: new EventEmitter(),
        prompt: async () => 'c',
        fetchImpl: async () => new Response(JSON.stringify({ id: 'usr_admin', name: 'admin', role: 'admin' }), { status: 200 }),
      });
      expect(login).toBe(0);
      const configFile = path.join(home, '.config', 'testbox', 'config.json');
      const mode = (await stat(configFile)).mode & 0o777;
      expect(mode).toBe(0o600);
      await chmod(path.dirname(configFile), 0o700);

      await writeFile(
        path.join(project, 'testbox.yml'),
        'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n    resources: light\n',
      );
      const start = await runCli(['start', '--direct', '--ssh-host', 'testbox'], io(home, project, remote, stdout, stderr));
      expect(start).toBe(0);
      const create = calls.find((call) => call.file === 'mutagen');
      expect(create?.args[0]).toBe('sync');
      expect(create?.args).toContain('--sync-mode=one-way-replica');
      expect(create?.args).toContain('--name=testbox-demo-local');
      expect(create?.args.at(-2)).toBe(project);
      expect(create?.args.at(-1)).toBe('testbox:~/testbox/workspaces/local/demo');
      expect(buildMutagenCreateArgs({
        name: 'demo',
        source: project,
        destination: 'testbox:~/testbox/app',
        ignore: ['node_modules'],
      })).toContain('--ignore=node_modules');

      calls.length = 0;
      const failed = await runCli(['verify', 'unit', '--direct', '--json'], {
        ...io(home, project, remote, stdout, stderr),
        remote: {
          async run(file, args): Promise<CommandResult> {
            calls.push({ file, args });
            if (file === 'mutagen') return { code: 0, stdout: '', stderr: '' };
            const command = args[args.length - 1] ?? '';
            if (command.includes('nodeVersion')) return { code: 0, stdout: JSON.stringify({ nodeVersion: 'v22.0.0', arch: 'x64', platform: 'linux', xcodeVersion: null }), stderr: '' };
            return { code: 3, stdout: 'nope', stderr: '' };
          },
        },
      });
      expect(failed).toBe(1);
      expect(stdout.join('')).toContain('"type":"summary"');
      const ssh = calls.find((call) => call.file === 'ssh');
      expect(ssh?.args.slice(0, 4)).toEqual(buildSshArgs('testbox', 'placeholder').slice(0, 4));
      expect(ssh?.args.at(-1)).toContain('bash -c');

      const sync = await runCli(['verify', 'unit', '--direct'], {
        ...io(home, project, remote, stdout, stderr),
        remote: {
          async run(file): Promise<CommandResult> {
            if (file === 'mutagen') return { code: 1, stdout: '', stderr: 'flush failed' };
            return { code: 0, stdout: '', stderr: '' };
          },
        },
      });
      expect(sync).toBe(10);

      const queued = await runCli(['verify', 'missing'], io(home, project, remote, stdout, stderr));
      expect(queued).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('streams a queued verify and exits 1 when the job fails', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { mkdir, writeFile: write } = await import('fs/promises');
    await mkdir(path.join(home, '.config', 'testbox'), { recursive: true });
    await write(
      path.join(home, '.config', 'testbox', 'config.json'),
      JSON.stringify({
        apiUrl: 'http://api.test',
        token: 'user-token-123456',
        sshHost: 'testbox',
        remoteRoot: '~/testbox',
        snapshotBin: 'testbox/app/packages/worker/dist/snapshot-cli.js',
      }),
    );
    await write(
      path.join(project, 'testbox.yml'),
      'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n    resources: light\n    artifacts: ["coverage/**"]\n',
    );
    await mkdir(path.join(project, '.testbox'), { recursive: true });
    await write(
      path.join(project, '.testbox', 'workspace.json'),
      JSON.stringify({
        id: 'ws_123',
        project: 'demo',
        sessionName: 'testbox-demo-usr_abc',
        stagingRel: 'workspaces/usr_abc/demo',
        sshHost: 'testbox',
        remoteRoot: '~/testbox',
        direct: false,
        configDir: project,
      }),
    );
    const remote: RemoteRunner = {
      async run(file, args) {
        if (file === 'mutagen') return { code: 0, stdout: '', stderr: '' };
        const command = args.at(-1) ?? '';
        if (command.includes('snapshot-cli')) {
          return { code: 0, stdout: `${JSON.stringify({ digest: 'ab'.repeat(32), relPath: 'snapshots/snap' })}\n`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await runCli(['--json', 'verify', 'unit'], {
      ...io(home, project, remote, stdout, stderr),
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/snapshots')) {
          return new Response(JSON.stringify({ id: 'snap', digest: 'ab'.repeat(32) }), { status: 201 });
        }
        if (url.endsWith('/jobs') && init?.method === 'POST') {
          return new Response(JSON.stringify({ job: { id: 'job_123', state: 'queued', exitCode: null, error: null }, superseded: [] }), { status: 201 });
        }
        if (url.endsWith('/events')) {
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode('event: log\ndata: {"stream":"stdout","line":"failed assertion","offset":1}\n\n'));
              controller.enqueue(enc.encode('event: done\ndata: {"state":"failed","exitCode":2,"error":"exit 2"}\n\n'));
              controller.close();
            },
          });
          return new Response(stream, { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    expect(code).toBe(1);
    const lines = stdout.join('').trim().split('\n').map((line) => JSON.parse(line) as { type: string; line?: string; exitCode?: number });
    expect(lines.some((line) => line.type === 'log' && line.line === 'failed assertion')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'summary', state: 'failed', exitCode: 2 });
    expect(remoteBash("printf %s ok")).toContain('bash -c');
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
});

function io(
  home: string,
  project: string,
  remote: RemoteRunner,
  stdout: string[],
  stderr: string[],
) {
  return {
    homeDir: home,
    cwd: project,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    remote,
    isTTY: false,
    signals: new EventEmitter(),
    prompt: async () => 'c',
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  };
}

function fakeRemote(calls: { file: string; args: string[] }[]): RemoteRunner {
  return {
    async run(file, args) {
      calls.push({ file, args });
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}
