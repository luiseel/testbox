import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { chmod, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { buildMutagenCreateArgs, buildSshArgs, remoteBash } from '@testbox/shared';
import { attachInterrupt } from '../src/interrupt';
import { exitAfterFlush, runCli } from '../src/main';
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

describe('exit', () => {
  it('exits only after stdout and stderr have flushed', () => {
    const callbacks: (() => void)[] = [];
    const stream = { write: (_chunk: string, cb: () => void) => (callbacks.push(cb), false) };
    const exits: number[] = [];
    exitAfterFlush(3, [stream, stream], (code) => exits.push(code));
    callbacks[0]?.();
    expect(exits).toEqual([]);
    callbacks[1]?.();
    expect(exits).toEqual([3]);
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
      const login = await runCli(
        ['login', '--token', 'token-value-123456', '--api-url', 'http://api.test', '--ssh-host', 'testbox'],
        {
          homeDir: home,
          cwd: project,
          stdout: { write: (chunk) => stdout.push(chunk) },
          stderr: { write: (chunk) => stderr.push(chunk) },
          remote,
          isTTY: false,
          signals: new EventEmitter(),
          prompt: async () => 'c',
          fetchImpl: async () =>
            new Response(JSON.stringify({ id: 'usr_admin', name: 'admin', role: 'admin' }), { status: 200 }),
        },
      );
      expect(login).toBe(0);
      const configFile = path.join(home, '.config', 'testbox', 'config.json');
      const mode = (await stat(configFile)).mode & 0o777;
      expect(mode).toBe(0o600);
      await chmod(path.dirname(configFile), 0o700);

      await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
      const start = await runCli(
        ['start', '--direct', '--ssh-host', 'testbox'],
        io(home, project, remote, stdout, stderr),
      );
      expect(start).toBe(0);
      const create = calls.find((call) => call.file === 'mutagen' && call.args[1] === 'create');
      expect(create?.args[0]).toBe('sync');
      expect(create?.args).toContain('--sync-mode=one-way-replica');
      expect(create?.args.find((arg) => arg.startsWith('--name='))).toMatch(/^--name=testbox-demo-[0-9a-f]{12}$/);
      expect(create?.args.at(-2)).toBe(project);
      expect(create?.args.at(-1)).toMatch(/^testbox:~\/testbox\/workspaces\/local\/demo\/[0-9a-f]{12}$/);
      expect(
        buildMutagenCreateArgs({
          name: 'demo',
          source: project,
          destination: 'testbox:~/testbox/app',
          ignore: ['node_modules'],
        }),
      ).toContain('--ignore=node_modules');

      calls.length = 0;
      const failed = await runCli(['verify', 'unit', '--direct', '--json'], {
        ...io(home, project, remote, stdout, stderr),
        remote: {
          async run(file, args): Promise<CommandResult> {
            calls.push({ file, args });
            if (file === 'mutagen') return { code: 0, stdout: '', stderr: '' };
            const command = args[args.length - 1] ?? '';
            if (command.includes('nodeVersion'))
              return {
                code: 0,
                stdout: JSON.stringify({ nodeVersion: 'v22.0.0', arch: 'x64', platform: 'linux', xcodeVersion: null }),
                stderr: '',
              };
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
      expect(queued).toBe(2);
      expect(stderr.join('')).toContain('unknown profile missing; the profiles in');
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
      'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n    artifacts: ["coverage/**"]\n',
    );
    await mkdir(path.join(project, '.testbox'), { recursive: true });
    await write(
      path.join(project, '.testbox', 'workspace.json'),
      JSON.stringify({
        id: 'ws_123',
        project: 'demo',
        sessionName: 'testbox-demo-usr-abc',
        stagingRel: 'workspaces/usr_abc/demo/ws_123',
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
          return {
            code: 0,
            stdout: `${JSON.stringify({ digest: 'ab'.repeat(32), relPath: 'snapshots/snap' })}\n`,
            stderr: '',
          };
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
          return new Response(
            JSON.stringify({ job: { id: 'job_123', state: 'queued', exitCode: null, error: null }, superseded: [] }),
            { status: 201 },
          );
        }
        if (url.endsWith('/events')) {
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode('event: log\ndata: {"stream":"stdout","line":"failed assertion","offset":1}\n\n'),
              );
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
    const lines = stdout
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; line?: string; exitCode?: number });
    expect(lines.some((line) => line.type === 'log' && line.line === 'failed assertion')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'summary', state: 'failed', exitCode: 2 });
    expect(remoteBash('printf %s ok')).toContain('bash -c');
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  it('sends the checkout path, branch, commit, and dirty flag with the job, and only the path when git fails', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await writeQueuedSetup(home, project);
      const sent: unknown[] = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/snapshots'))
          return new Response(JSON.stringify({ id: 'snap', digest: 'ab'.repeat(32) }), { status: 201 });
        if (url.endsWith('/jobs') && init?.method === 'POST') {
          sent.push((JSON.parse(String(init.body)) as { source?: unknown }).source);
          return new Response(
            JSON.stringify({ job: { id: 'job_123', state: 'queued', exitCode: null, error: null }, superseded: [] }),
            { status: 201 },
          );
        }
        if (url.endsWith('/events')) {
          return new Response('event: done\ndata: {"state":"succeeded","exitCode":0,"error":null}\n\n', {
            status: 200,
          });
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      const remote = (git: (args: string[]) => CommandResult): RemoteRunner => ({
        async run(file, args) {
          if (file === 'git') return git(args);
          if (file === 'ssh')
            return {
              code: 0,
              stdout: `${JSON.stringify({ digest: 'ab'.repeat(32), relPath: 'snapshots/snap' })}\n`,
              stderr: '',
            };
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      const repo = remote((args) => {
        if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'TGN-811\n', stderr: '' };
        if (args.includes('--short')) return { code: 0, stdout: '3edf65d\n', stderr: '' };
        return { code: 0, stdout: ' M src/app.ts\n', stderr: '' };
      });
      expect(await runCli(['verify', 'unit'], { ...io(home, project, repo, stdout, stderr), fetchImpl })).toBe(0);
      expect(sent[0]).toEqual({ path: project, branch: 'TGN-811', commit: '3edf65d', dirty: true });
      expect(stderr.join('')).toContain(`source: ${project} TGN-811@3edf65d (dirty)\n`);

      const noRepo = remote(() => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }));
      expect(
        await runCli(['verify', 'unit', '--json'], { ...io(home, project, noRepo, stdout, stderr), fetchImpl }),
      ).toBe(0);
      expect(sent[1]).toEqual({ path: project });
      expect(stdout.join('')).toContain(JSON.stringify({ type: 'source', path: project }));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('syncs to the selected worker and exits 11 when no worker can run the profile', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: { file: string; args: string[] }[] = [];
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
      'project: demo\nprofiles:\n  ios:\n    cmd: xcodebuild test\n    requires: [macos, xcode]\n',
    );
    await mkdir(path.join(project, '.testbox'), { recursive: true });
    await write(
      path.join(project, '.testbox', 'workspace.json'),
      JSON.stringify({
        id: 'ws_123',
        project: 'demo',
        sessionName: 'testbox-demo-usr-abc',
        stagingRel: 'workspaces/usr_abc/demo/ws_123',
        sshHost: 'testbox',
        remoteRoot: '~/testbox',
        direct: false,
        configDir: project,
      }),
    );
    let pinned = '';
    const remote: RemoteRunner = {
      async run(file, args) {
        calls.push({ file, args });
        if (file === 'ssh') {
          return {
            code: 0,
            stdout: `${JSON.stringify({ digest: 'ab'.repeat(32), relPath: 'snapshots/snap' })}\n`,
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const synced = await runCli(['verify', 'ios'], {
      ...io(home, project, remote, stdout, stderr),
      fetchImpl: async (input, init) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as { targetWorkerId?: string }) : {};
        if (url.endsWith('/workers/select')) {
          return new Response(
            JSON.stringify({ worker: { id: 'mac-1', sshHost: 'testbox@mac-1', labels: ['macos', 'xcode'] } }),
            { status: 201 },
          );
        }
        if (url.endsWith('/snapshots')) {
          return new Response(JSON.stringify({ id: 'snap', digest: 'ab'.repeat(32) }), { status: 201 });
        }
        if (url.endsWith('/jobs') && init?.method === 'POST') {
          pinned = body.targetWorkerId ?? '';
          return new Response(
            JSON.stringify({ job: { id: 'job_123', state: 'queued', exitCode: null, error: null }, superseded: [] }),
            { status: 201 },
          );
        }
        if (url.endsWith('/events')) {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: done\ndata: {"state":"succeeded","exitCode":0,"error":null}\n\n'),
              );
              controller.close();
            },
          });
          return new Response(stream, { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    expect(synced).toBe(0);
    expect(pinned).toBe('mac-1');
    const created = calls.find((call) => call.file === 'mutagen' && call.args.includes('create'));
    expect(created?.args.at(-1)).toBe('testbox@mac-1:~/testbox/workspaces/usr_abc/demo/ws_123');
    calls.length = 0;
    stderr.length = 0;
    const missing = await runCli(['verify', 'ios'], {
      ...io(home, project, remote, stdout, stderr),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'NO_WORKER',
              message:
                'no registered worker can satisfy required labels: macos, xcode; registered: linux-1 [linux, x64]',
            },
          }),
          { status: 503 },
        ),
    });
    expect(missing).toBe(11);
    expect(stderr.join('')).toContain('no registered worker can satisfy required labels: macos, xcode');
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  it('gives two checkouts of one repo two direct-mode folders and sessions', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const main = await mkdtemp(path.join(os.tmpdir(), 'tb-main-'));
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'tb-worktree-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const mutagen = fakeMutagen();
    try {
      for (const dir of [main, worktree]) {
        await writeFile(path.join(dir, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
        expect(
          await runCli(['start', '--direct', '--ssh-host', 'testbox'], io(home, dir, mutagen.remote, stdout, stderr)),
        ).toBe(0);
      }
      expect(mutagen.created.map((session) => session.source)).toEqual([main, worktree]);
      const [first, second] = mutagen.created;
      expect(first?.destination).not.toBe(second?.destination);
      expect(first?.name).not.toBe(second?.name);
      expect(mutagen.live.size).toBe(2);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(main, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('reuses the workspace when start runs again and replaces it when the API lost it', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { mkdir, readFile } = await import('fs/promises');
    await mkdir(path.join(home, '.config', 'testbox'), { recursive: true });
    await writeFile(
      path.join(home, '.config', 'testbox', 'config.json'),
      JSON.stringify({
        apiUrl: 'http://api.test',
        token: 'user-token-123456',
        sshHost: 'testbox',
        remoteRoot: '~/testbox',
      }),
    );
    await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
    const workspaces = new Map<string, { id: string; stagingRel: string; project: string; ownerId: string }>();
    let nextId = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/workspaces') && init?.method === 'POST') {
        nextId += 1;
        const id = `ws_${nextId}`;
        const workspace = { id, stagingRel: `workspaces/usr_abc/demo/${id}`, project: 'demo', ownerId: 'usr_abc' };
        workspaces.set(id, workspace);
        return new Response(JSON.stringify(workspace), { status: 201 });
      }
      const match = /\/v1\/workspaces\/([^/]+)$/.exec(url);
      if (match && init?.method === 'GET') {
        const workspace = workspaces.get(match[1] ?? '');
        if (!workspace)
          return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'workspace not found' } }), {
            status: 404,
          });
        return new Response(JSON.stringify(workspace), { status: 200 });
      }
      if (url.endsWith('/workers/select')) {
        return new Response(JSON.stringify({ worker: { id: 'linux-1', sshHost: 'testbox@linux-1', labels: [] } }), {
          status: 201,
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const mutagen = fakeMutagen();
    const readState = async () =>
      JSON.parse(await readFile(path.join(project, '.testbox', 'workspace.json'), 'utf8')) as {
        id: string;
        sessionName: string;
        stagingRel: string;
      };
    try {
      expect(await runCli(['start'], { ...io(home, project, mutagen.remote, stdout, stderr), fetchImpl })).toBe(0);
      const first = await readState();
      expect(first.stagingRel).toBe('workspaces/usr_abc/demo/ws_1');

      stderr.length = 0;
      expect(await runCli(['start'], { ...io(home, project, mutagen.remote, stdout, stderr), fetchImpl })).toBe(0);
      expect(await readState()).toMatchObject({ id: first.id, sessionName: first.sessionName });
      expect(workspaces.size).toBe(1);
      expect(mutagen.created).toHaveLength(1);
      expect([...mutagen.live.keys()]).toEqual([first.sessionName]);
      expect(stderr.join('')).toContain('reused workspace ws_1');

      workspaces.clear();
      expect(await runCli(['start'], { ...io(home, project, mutagen.remote, stdout, stderr), fetchImpl })).toBe(0);
      const replaced = await readState();
      expect(replaced.stagingRel).toBe('workspaces/usr_abc/demo/ws_2');
      expect(mutagen.created).toHaveLength(2);
      expect([...mutagen.live.keys()]).toEqual([replaced.sessionName]);
      expect(mutagen.created.at(-1)?.destination).toBe('testbox@linux-1:~/testbox/workspaces/usr_abc/demo/ws_2');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('replaces the session when the worker moves host, migrates an old shared folder, and ignores a copied state file', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tb-proj-'));
    const copy = await mkdtemp(path.join(os.tmpdir(), 'tb-copy-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { mkdir, readFile, cp } = await import('fs/promises');
    await mkdir(path.join(home, '.config', 'testbox'), { recursive: true });
    await writeFile(
      path.join(home, '.config', 'testbox', 'config.json'),
      JSON.stringify({ apiUrl: 'http://api.test', token: 'user-token-123456', remoteRoot: '~/testbox' }),
    );
    await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
    const workspaces = new Map<string, { id: string; stagingRel: string; project: string; ownerId: string }>();
    const deleted: string[] = [];
    let nextId = 0;
    let host = 'testbox@linux-1';
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/workspaces') && init?.method === 'POST') {
        nextId += 1;
        const id = `ws_${nextId}`;
        const workspace = { id, stagingRel: `workspaces/usr_abc/demo/${id}`, project: 'demo', ownerId: 'usr_abc' };
        workspaces.set(id, workspace);
        return new Response(JSON.stringify(workspace), { status: 201 });
      }
      const match = /\/v1\/workspaces\/([^/]+)$/.exec(url);
      if (match && init?.method === 'DELETE') {
        deleted.push(match[1] ?? '');
        workspaces.delete(match[1] ?? '');
        return new Response('{"ok":true}', { status: 200 });
      }
      if (match && init?.method === 'GET') {
        const workspace = workspaces.get(match[1] ?? '');
        if (!workspace)
          return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'workspace not found' } }), {
            status: 404,
          });
        return new Response(JSON.stringify(workspace), { status: 200 });
      }
      if (url.endsWith('/workers/select')) {
        return new Response(JSON.stringify({ worker: { id: 'linux-1', sshHost: host, labels: [] } }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const mutagen = fakeMutagen();
    const readState = async (dir: string) =>
      JSON.parse(await readFile(path.join(dir, '.testbox', 'workspace.json'), 'utf8')) as {
        id: string;
        sessionName: string;
        sshHost: string;
      };
    try {
      // An old state file: the workspace still uses the shared folder of the old layout.
      workspaces.set('ws_old', {
        id: 'ws_old',
        stagingRel: 'workspaces/usr_abc/demo',
        project: 'demo',
        ownerId: 'usr_abc',
      });
      await mkdir(path.join(project, '.testbox'), { recursive: true });
      await writeFile(
        path.join(project, '.testbox', 'workspace.json'),
        JSON.stringify({
          id: 'ws_old',
          project: 'demo',
          sessionName: 'testbox-demo-ws-old-linux-1',
          stagingRel: 'workspaces/usr_abc/demo',
          sshHost: host,
          remoteRoot: '~/testbox',
          direct: false,
          configDir: project,
          workerId: 'linux-1',
          sessions: { 'linux-1': { sessionName: 'testbox-demo-ws-old-linux-1', sshHost: host } },
        }),
      );
      mutagen.live.set('testbox-demo-ws-old-linux-1', {
        source: project,
        destination: `${host}:~/testbox/workspaces/usr_abc/demo`,
      });
      expect(await runCli(['start'], { ...io(home, project, mutagen.remote, stdout, stderr), fetchImpl })).toBe(0);
      const first = await readState(project);
      expect(first.id).toBe('ws_1');
      expect(deleted).toEqual(['ws_old']);
      expect(mutagen.live.has('testbox-demo-ws-old-linux-1')).toBe(false);
      expect([...mutagen.live.keys()]).toEqual([first.sessionName]);

      // The same worker answers from another host: the old session goes, a new one comes, no duplicate name.
      host = 'testbox@10.0.0.9';
      expect(await runCli(['start'], { ...io(home, project, mutagen.remote, stdout, stderr), fetchImpl })).toBe(0);
      const moved = await readState(project);
      expect(moved.id).toBe('ws_1');
      expect(moved.sshHost).toBe(host);
      expect([...mutagen.live.keys()]).toEqual([moved.sessionName]);
      expect(mutagen.created.at(-1)?.destination).toBe('testbox@10.0.0.9:~/testbox/workspaces/usr_abc/demo/ws_1');

      // A copy of the checkout, state file included, gets its own workspace and leaves the original's session alone.
      await cp(project, copy, { recursive: true });
      expect(await runCli(['start'], { ...io(home, copy, mutagen.remote, stdout, stderr), fetchImpl })).toBe(0);
      const copied = await readState(copy);
      expect(copied.id).toBe('ws_2');
      expect(mutagen.live.has(moved.sessionName)).toBe(true);
      expect(mutagen.live.get(copied.sessionName)?.source).toBe(copy);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
      await rm(copy, { recursive: true, force: true });
    }
  });
});

function io(home: string, project: string, remote: RemoteRunner, stdout: string[], stderr: string[]) {
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

/** A logged-in user and a started workspace, so verify goes to the queue. */
async function writeQueuedSetup(home: string, project: string): Promise<void> {
  const { mkdir } = await import('fs/promises');
  await mkdir(path.join(home, '.config', 'testbox'), { recursive: true });
  await writeFile(
    path.join(home, '.config', 'testbox', 'config.json'),
    JSON.stringify({
      apiUrl: 'http://api.test',
      token: 'user-token-123456',
      sshHost: 'testbox',
      remoteRoot: '~/testbox',
    }),
  );
  await writeFile(path.join(project, 'testbox.yml'), 'project: demo\nprofiles:\n  unit:\n    cmd: pnpm test\n');
  await mkdir(path.join(project, '.testbox'), { recursive: true });
  await writeFile(
    path.join(project, '.testbox', 'workspace.json'),
    JSON.stringify({
      id: 'ws_123',
      project: 'demo',
      sessionName: 'testbox-demo-usr-abc',
      stagingRel: 'workspaces/usr_abc/demo/ws_123',
      sshHost: 'testbox',
      remoteRoot: '~/testbox',
      direct: false,
      configDir: project,
    }),
  );
}

function fakeRemote(calls: { file: string; args: string[] }[]): RemoteRunner {
  return {
    async run(file, args) {
      calls.push({ file, args });
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

/** A Mutagen stand-in that remembers which sessions exist, so tests can see leaked sessions. */
function fakeMutagen() {
  const live = new Map<string, { source: string; destination: string }>();
  const created: { name: string; source: string; destination: string }[] = [];
  const remote: RemoteRunner = {
    async run(file, args) {
      if (file !== 'mutagen') return { code: 0, stdout: '', stderr: '' };
      const [, verb] = args;
      if (verb === 'create') {
        const name = (args.find((arg) => arg.startsWith('--name=')) ?? '').slice('--name='.length);
        if (live.has(name)) return { code: 1, stdout: '', stderr: `session name "${name}" already in use` };
        const session = { source: args.at(-2) ?? '', destination: args.at(-1) ?? '' };
        live.set(name, session);
        created.push({ name, ...session });
      } else if (verb === 'list') {
        const sessions = [...live].map(([name, session]) => ({
          name,
          alpha: { path: session.source },
          beta: { path: session.destination },
        }));
        return { code: 0, stdout: JSON.stringify(sessions), stderr: '' };
      } else if (verb === 'terminate') {
        const name = args.at(-1) ?? '';
        if (!live.delete(name)) return { code: 1, stdout: '', stderr: 'no session' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { live, created, remote };
}
