import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { defaultUserName } from '../src/admin';
import { bootstrapDir, composeScript, ipFromSshHost, parseResult, runBootstrap } from '../src/bootstrap';
import { adminConfigPath, userConfigPath } from '../src/config-store';
import { runCli } from '../src/main';
import type { CommandResult, RemoteRunner, RunOptions } from '../src/remote';

/** Runs what the CLI would send over SSH with a local `bash -s` instead. */
const localBash: RemoteRunner = {
  run(file: string, _args: string[], opts?: RunOptions): Promise<CommandResult> {
    if (file !== 'ssh') throw new Error(`unexpected ${file}`);
    return new Promise((resolve) => {
      const child = spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        opts?.onStderr?.(chunk.toString());
      });
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(opts?.input ?? '');
    });
  },
};

describe('bootstrap scripts', () => {
  it('sends inputs on stdin, quoted, and reads the control-plane secrets', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'tb-cp-'));
    await writeFile(
      path.join(repo, '.env'),
      'TESTBOX_WORKER_TOKEN=w0rker\nTESTBOX_BOOTSTRAP_TOKEN=b00t\nTESTBOX_REDIS_PASSWORD=pa55\nTESTBOX_API_PORT=3000\nTESTBOX_REDIS_PORT=6379\n',
    );
    const script = await composeScript('read-secrets', { TB_REPO_DIR: `${repo}/../${path.basename(repo)}` });
    expect(script.startsWith(`export TB_REPO_DIR='${repo}/../${path.basename(repo)}'`)).toBe(true);
    await expect(composeScript('read-secrets', { 'TB_X; rm -rf /': 'x' })).rejects.toThrow(/invalid bootstrap variable/);

    const secrets = await runBootstrap<Record<string, string>>({
      runner: localBash,
      sshHost: 'host',
      script: 'read-secrets',
      env: { TB_REPO_DIR: repo },
    });
    expect(secrets).toEqual({ workerToken: 'w0rker', bootstrapToken: 'b00t', redisPassword: 'pa55', apiPort: '3000', redisPort: '6379' });

    await rm(path.join(repo, '.env'));
    await expect(
      runBootstrap({ runner: localBash, sshHost: 'host', script: 'read-secrets', env: { TB_REPO_DIR: repo } }),
    ).rejects.toThrow(/\.env not found/);
    await rm(repo, { recursive: true, force: true });
  });

  it('keeps existing secrets in .env and adds only the missing ones', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tb-lib-'));
    await copyFile(path.join(bootstrapDir(), 'lib.sh'), path.join(dir, 'lib.sh'));
    await writeFile(
      path.join(dir, 'probe.sh'),
      [
        'f="$TB_FILE"',
        'env_default "$f" A "$(random_secret)"',
        'env_default "$f" B new-b',
        'result "{\\"a\\":\\"$(env_get "$f" A)\\",\\"b\\":\\"$(env_get "$f" B)\\",\\"home\\":\\"$(expand_home "~/x")\\"}"',
      ].join('\n'),
    );
    const file = path.join(dir, '.env');
    await writeFile(file, 'B=old-b\n');
    const run = async () => {
      const input = await composeScript('probe', { TB_FILE: file }, dir);
      const result = await localBash.run('ssh', [], { input });
      expect(result.code).toBe(0);
      return parseResult<{ a: string; b: string; home: string }>(result.stdout);
    };
    const first = await run();
    expect(first.a).toMatch(/^[0-9a-f]{64}$/);
    expect(first.b).toBe('old-b');
    expect(first.home).toBe(`${os.homedir()}/x`);
    const second = await run();
    expect(second.a).toBe(first.a);
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('takes the address from an IP ssh host and makes a valid user name', () => {
    expect(ipFromSshHost('luiseel@192.168.1.62')).toBe('192.168.1.62');
    expect(ipFromSshHost('omarchy.local')).toBeNull();
    expect(defaultUserName('Luis.Espinoza')).toBe('luis-espinoza');
    expect(defaultUserName('1')).toBe('admin-user');
  });
});

describe('testbox admin', () => {
  it('sets up the control plane, logs in, and issues user tokens', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-admin-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const scripts: { args: string[]; input: string }[] = [];
    const remote: RemoteRunner = {
      async run(file, args, opts): Promise<CommandResult> {
        if (file === 'git') return { code: 0, stdout: 'git@example.com:me/testbox.git\n', stderr: '' };
        scripts.push({ args, input: opts?.input ?? '' });
        opts?.onStderr?.('==> docker compose up\n');
        if ((opts?.input ?? '').includes('Print the control-plane secrets')) {
          return {
            code: 0,
            stdout: 'TESTBOX_RESULT {"workerToken":"w","bootstrapToken":"boot","redisPassword":"r","apiPort":"3000","redisPort":"6379"}\n',
            stderr: '',
          };
        }
        return { code: 0, stdout: 'TESTBOX_RESULT {"apiPort":3000,"redisPort":6379,"repoDir":"/home/x/testbox/app","redisPasswordAdded":true}\n', stderr: '' };
      },
    };
    const users = new Map<string, string>();
    const requests: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = new URL(String(url));
      requests.push(`${init?.method ?? 'GET'} ${target.pathname}${target.search}`);
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (target.pathname === '/v1/healthz') return json({ ok: true });
      if (target.pathname === '/v1/users' && init?.method === 'GET') {
        expect(auth).toBe('Bearer boot');
        const name = target.searchParams.get('name') ?? '';
        return json({ users: users.has(name) ? [{ id: users.get(name), name, role: 'user' }] : [] });
      }
      if (target.pathname === '/v1/users' && init?.method === 'POST') {
        const { name } = JSON.parse(String(init.body)) as { name: string };
        users.set(name, `usr_${name}`);
        return json({ id: `usr_${name}`, name });
      }
      if (target.pathname.endsWith('/tokens')) return json({ token: `tok-${requests.length}`, userId: 'x' });
      return new Response('{}', { status: 404 });
    };
    const io = {
      homeDir: home,
      cwd: home,
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      remote,
      isTTY: false,
      signals: new EventEmitter(),
      prompt: async () => '',
      fetchImpl: fetchImpl as typeof fetch,
    };
    try {
      expect(await runCli(['admin', 'init-control-plane', 'omarchy.local'], io)).toBe(1);
      expect(stderr.join('')).toContain('pass --address');

      expect(await runCli(['admin', 'init-control-plane', 'me@10.0.0.5', '--user', 'ana'], io)).toBe(0);
      expect(scripts[0]?.args.slice(-2)).toEqual(['--', 'bash -s']);
      expect(scripts[0]?.input).toContain("export TB_GIT_URL='git@example.com:me/testbox.git'");
      expect(scripts[0]?.input).toContain("export TB_GIT_REF='main'");
      expect(stderr.join('')).toContain('  ==> docker compose up');
      expect(stderr.join('')).toContain('Redis now has a password');
      const admin = JSON.parse(await readFile(adminConfigPath(home), 'utf8')) as { controlPlane: { address: string } };
      expect(admin.controlPlane.address).toBe('10.0.0.5');
      expect((await stat(adminConfigPath(home))).mode & 0o777).toBe(0o600);
      const login = JSON.parse(await readFile(userConfigPath(home), 'utf8')) as { apiUrl: string; token: string };
      expect(login.apiUrl).toBe('http://10.0.0.5:3000');
      expect(login.token).toMatch(/^tok-/);
      expect(users.get('ana')).toBe('usr_ana');

      stdout.length = 0;
      expect(await runCli(['admin', 'add-user', 'ana'], io)).toBe(0);
      expect(stdout.join('')).toMatch(/^testbox login --api-url http:\/\/10\.0\.0\.5:3000 --token tok-\d+\n$/);
      expect(requests.filter((r) => r === 'POST /v1/users')).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
