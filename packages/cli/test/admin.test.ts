import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it, vi } from 'vitest';
import { defaultUserName, workerRedisUrl } from '../src/admin';
import { bootstrapDir, composeScript, ipFromSshHost, parseResult, runBootstrap } from '../src/bootstrap';
import { adminConfigPath, userConfigPath, writeAdminConfig, writeUserConfig } from '../src/config-store';
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

  it('follows a rewritten branch but never drops a commit that exists only on the host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tb-git-'));
    const git = (cwd: string, ...args: string[]) =>
      promisify(execFile)('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd });
    const dir = path.join(root, 'scripts');
    await mkdir(dir);
    await copyFile(path.join(bootstrapDir(), 'lib.sh'), path.join(dir, 'lib.sh'));
    await writeFile(path.join(dir, 'sync.sh'), 'sync_repo "$TB_DIR"\nresult "{\\"head\\":\\"$(git -C "$TB_DIR" log -1 --format=%s)\\"}"\n');
    const sync = async () => {
      const input = await composeScript('sync', { TB_DIR: path.join(root, 'host'), TB_GIT_URL: path.join(root, 'origin.git'), TB_GIT_REF: 'main' }, dir);
      return localBash.run('ssh', [], { input });
    };
    try {
      await git(root, 'init', '--bare', 'origin.git');
      await git(root, 'clone', 'origin.git', 'dev');
      const dev = path.join(root, 'dev');
      await git(dev, 'commit', '--allow-empty', '-m', 'one');
      await git(dev, 'push', 'origin', 'HEAD:main');
      expect(parseResult<{ head: string }>((await sync()).stdout).head).toBe('one');

      await git(dev, 'commit', '--amend', '--allow-empty', '-m', 'one rewritten');
      await git(dev, 'push', '--force', 'origin', 'HEAD:main');
      expect(parseResult<{ head: string }>((await sync()).stdout).head).toBe('one rewritten');

      await git(path.join(root, 'host'), 'commit', '--allow-empty', '-m', 'only on the host');
      await git(dev, 'commit', '--amend', '--allow-empty', '-m', 'rewritten again');
      await git(dev, 'push', '--force', 'origin', 'HEAD:main');
      const refused = await sync();
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('commits on main that are not on the remote');
      expect((await git(path.join(root, 'host'), 'log', '-1', '--format=%s')).stdout.trim()).toBe('only on the host');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('composes every setup script into valid bash', async () => {
    const names = (await readdir(bootstrapDir())).filter((name) => name.endsWith('.sh') && name !== 'lib.sh');
    expect(names.sort()).toEqual(['authorize-key.sh', 'control-plane.sh', 'read-secrets.sh', 'worker.sh']);
    for (const name of names) {
      const script = await composeScript(name.replace(/\.sh$/, ''), { TB_X: 'y' });
      await expect(promisify(execFile)('bash', ['-n', '-c', script])).resolves.toBeDefined();
    }
  });

  it('installs the LaunchAgent and the systemd unit with bin on PATH, labels, and mode 0600', async () => {
    const repo = path.resolve(bootstrapDir(), '..', '..');
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-svc-'));
    const stubs = path.join(home, 'stubs');
    await mkdir(stubs);
    for (const name of ['launchctl', 'systemctl']) {
      // `launchctl print` exits 1: the agent is not loaded, so install does not wait.
      await writeFile(path.join(stubs, name), `#!/bin/sh\necho "$0 $*" >> "${home}/calls.log"\n[ "$1" = print ] && exit 1\nexit 0\n`);
      await chmod(path.join(stubs, name), 0o755);
    }
    await mkdir(path.join(repo, 'packages', 'worker', 'dist'), { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      PATH: `${stubs}:${process.env.PATH ?? ''}`,
      NODE_BIN: process.execPath,
      TESTBOX_DATA_DIR: path.join(home, 'testbox'),
      REDIS_URL: 'redis://:pw@10.0.0.5:6379',
      TESTBOX_API_URL: 'http://10.0.0.5:3000',
      TESTBOX_WORKER_TOKEN: 'w0rker',
      TESTBOX_WORKER_ID: 'mac-1',
      TESTBOX_SSH_HOST: 'me@10.0.0.9',
      TESTBOX_LABELS: 'gpu,big-disk',
    };
    const run = promisify(execFile);
    const mainJs = path.join(repo, 'packages', 'worker', 'dist', 'main.js');
    const hadMain = await stat(mainJs).then(() => true, () => false);
    if (!hadMain) await writeFile(mainJs, '');
    try {
      await run('sh', [path.join(repo, 'deploy', 'install-launchagent.sh')], { env });
      const plist = path.join(home, 'Library', 'LaunchAgents', 'com.testbox.worker.plist');
      const text = await readFile(plist, 'utf8');
      expect(text).toContain(`<string>${home}/testbox/bin:/opt/homebrew/bin:`);
      expect(text).toContain('<string>gpu,big-disk</string>');
      expect(text).toContain('<string>redis://:pw@10.0.0.5:6379</string>');
      expect((await stat(plist)).mode & 0o777).toBe(0o600);

      await run('sh', [path.join(repo, 'deploy', 'install-systemd.sh')], { env });
      const unit = path.join(home, '.config', 'systemd', 'user', 'testbox-worker.service');
      const unitText = await readFile(unit, 'utf8');
      expect(unitText).toContain(`Environment=PATH=${home}/testbox/bin:`);
      expect(unitText).toContain('Environment=TESTBOX_LABELS=gpu,big-disk');
      expect((await stat(unit)).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(home, 'calls.log'), 'utf8')).toContain('restart testbox-worker.service');
    } finally {
      if (!hadMain) await rm(mainJs, { force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('takes the address from an IP ssh host and makes a valid user name', () => {
    expect(workerRedisUrl('10.0.0.5', 6379, 'a/b')).toBe('redis://:a%2Fb@10.0.0.5:6379');
    expect(workerRedisUrl('10.0.0.5', 6379, '')).toBe('redis://10.0.0.5:6379');
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
      expect(await runCli(['admin', 'init-control-plane', 'omarchy.local'], io)).toBe(2);
      expect(stderr.join('')).toContain('pass --address');

      expect(await runCli(['admin', 'init-control-plane', 'me@10.0.0.5', '--user', 'ana'], io)).toBe(0);
      expect(scripts[0]?.args.slice(-2)).toEqual(['--', 'bash -s']);
      expect(scripts[0]?.input).toContain("export TB_GIT_URL='git@example.com:me/testbox.git'");
      expect(scripts[0]?.input).toContain("export TB_GIT_REF='master'");
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
      expect(stdout.join('')).toMatch(/^testbox setup --api-url http:\/\/10\.0\.0\.5:3000 --token tok-\d+\n$/);
      expect(requests.filter((r) => r === 'POST /v1/users')).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('adds a worker with the control-plane secrets and upgrades every worker', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-admin-w-'));
    const stderr: string[] = [];
    const scripts: { host: string; input: string }[] = [];
    const remote: RemoteRunner = {
      async run(file, args, opts): Promise<CommandResult> {
        if (file === 'git') return { code: 0, stdout: 'git@example.com:me/testbox.git\n', stderr: '' };
        const input = opts?.input ?? '';
        scripts.push({ host: args[args.length - 3] ?? '', input });
        if (input.includes('Print the control-plane secrets')) {
          return {
            code: 0,
            stdout: 'TESTBOX_RESULT {"workerToken":"w0rker","bootstrapToken":"boot","redisPassword":"pa55","apiPort":"3000","redisPort":"6379"}\n',
            stderr: '',
          };
        }
        if (input.includes("export TB_MODE='upgrade'") && args.includes('bad@10.0.0.8')) {
          return { code: 1, stdout: '', stderr: 'error: the worker service is not installed\n' };
        }
        return {
          code: 0,
          stdout: 'TESTBOX_RESULT {"os":"linux","workerId":"box-1","xcode":false,"localNetworkBlocked":false,"node":"v22.23.3"}\n',
          stderr: '',
        };
      },
    };
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const target = new URL(String(url));
      if (target.pathname === '/v1/healthz') return new Response('{"ok":true}', { status: 200 });
      if (target.pathname === '/v1/workers') {
        return new Response(
          JSON.stringify({
            workers: [
              { id: 'box-1', healthy: true, labels: ['linux', 'worker:box-1'], sshHost: 'me@10.0.0.7' },
              { id: 'bad-1', healthy: false, labels: [], sshHost: 'bad@10.0.0.8' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    };
    await writeAdminConfig(home, {
      controlPlane: { sshHost: 'me@10.0.0.5', address: '10.0.0.5', apiPort: 3000, redisPort: 6379, repoDir: '~/testbox/app' },
    });
    const io = {
      homeDir: home,
      cwd: home,
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      remote,
      isTTY: false,
      signals: new EventEmitter(),
      prompt: async () => '',
      fetchImpl: fetchImpl as typeof fetch,
    };
    try {
      expect(await runCli(['admin', 'add-worker', 'me@10.0.0.7', '--labels', 'gpu', '--no-smoke'], io)).toBe(0);
      const install = scripts.find((entry) => entry.input.includes("export TB_MODE='install'"));
      expect(install?.input).toContain("export TB_REDIS_URL='redis://:pa55@10.0.0.5:6379'");
      expect(install?.input).toContain("export TB_WORKER_TOKEN='w0rker'");
      expect(install?.input).toContain("export TB_ADDRESS='10.0.0.7'");
      expect(install?.input).toContain("export TB_LABELS='gpu'");
      expect(stderr.join('')).toContain('worker box-1 is healthy: linux, worker:box-1');

      scripts.length = 0;
      stderr.length = 0;
      expect(await runCli(['admin', 'upgrade', '--no-control-plane'], io)).toBe(1);
      const upgrades = scripts.filter((entry) => entry.input.includes("export TB_MODE='upgrade'"));
      expect(upgrades).toHaveLength(2);
      expect(upgrades[0]?.input).not.toContain('export TB_WORKER_TOKEN');
      expect(stderr.join('')).toContain('bad-1: worker failed on bad@10.0.0.8: the worker service is not installed');
      expect(stderr.join('')).toContain('1 of 2 workers did not come back');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

/** Run `fn` with a fake clock that moves while it waits: the admin waits are seconds long. */
async function fastClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  try {
    let done = false;
    const result = fn().finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(1_000);
    }
    return await result;
  } finally {
    vi.useRealTimers();
  }
}

const SECRETS = 'TESTBOX_RESULT {"workerToken":"w","bootstrapToken":"boot","redisPassword":"","apiPort":"3000","redisPort":"6379"}\n';
const WORKER = 'TESTBOX_RESULT {"os":"linux","workerId":"box-1","xcode":false,"localNetworkBlocked":false,"node":"v22.23.3"}\n';

/**
 * A home with a control plane, and an SSH stand-in that answers the read-secrets script.
 * `ssh` answers every other script; `fetchImpl` is the API.
 */
async function adminHome(
  ssh: (input: string, args: string[]) => CommandResult,
  fetchImpl: (url: URL) => Response,
): Promise<{ home: string; stdout: string[]; run: (argv: string[]) => Promise<{ code: number; summary: Record<string, unknown> }> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tb-admin-j-'));
  await writeAdminConfig(home, {
    controlPlane: { sshHost: 'me@10.0.0.5', address: '10.0.0.5', apiPort: 3000, redisPort: 6379, repoDir: '~/testbox/app' },
  });
  const stdout: string[] = [];
  const remote: RemoteRunner = {
    async run(file, args, opts): Promise<CommandResult> {
      if (file === 'git') return { code: 0, stdout: 'git@example.com:me/testbox.git\n', stderr: '' };
      if (file === 'mutagen') return { code: 1, stdout: '', stderr: 'mutagen daemon is not running' };
      const input = opts?.input ?? '';
      if (input.includes('Print the control-plane secrets')) return { code: 0, stdout: SECRETS, stderr: '' };
      return ssh(input, args);
    },
  };
  const io = {
    homeDir: home,
    cwd: home,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: () => undefined },
    remote,
    isTTY: false,
    signals: new EventEmitter(),
    prompt: async () => '',
    fetchImpl: (async (url: string | URL | Request) => fetchImpl(new URL(String(url)))) as typeof fetch,
  };
  const run = async (argv: string[]) => {
    stdout.length = 0;
    const code = await runCli([...argv, '--json'], io);
    const lines = stdout.join('').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.type === 'summary')).toHaveLength(1);
    const summary = lines.at(-1) as Record<string, unknown>;
    expect(summary).toMatchObject({ type: 'summary', exit: code });
    return { code, summary };
  };
  return { home, stdout, run };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('testbox admin --json: a summary on every path', () => {
  it('exits 2 for a missing address and a bad key, and maps an API error to its exit code', async () => {
    const { home, run } = await adminHome(
      () => ({ code: 0, stdout: 'TESTBOX_RESULT {"added":true}\n', stderr: '' }),
      (url) => (url.pathname === '/v1/users' ? json({ error: { code: 'AUTH', message: 'invalid token' } }, 401) : json({ workers: [] })),
    );
    try {
      const init = await run(['admin', 'init-control-plane', 'omarchy.local']);
      expect(init.code).toBe(2);
      expect(init.summary.error).toContain('pass --address');
      expect((await run(['admin', 'add-worker', 'omarchy.local'])).code).toBe(2);
      expect((await run(['admin', 'authorize', 'rm -rf /'])).code).toBe(2);
      const user = await run(['admin', 'add-user', 'ana']);
      expect(user.code).toBe(20);
      expect(user.summary.error).toBe('invalid token');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('exits 1 when a worker does not get the key or does not come back', async () => {
    const workers = [
      { id: 'box-1', healthy: true, labels: [], sshHost: 'me@10.0.0.7' },
      { id: 'bad-1', healthy: false, labels: [], sshHost: 'bad@10.0.0.8' },
    ];
    const { home, run } = await adminHome(
      (input, args) => {
        if (args.includes('bad@10.0.0.8')) return { code: 255, stdout: '', stderr: 'bad@10.0.0.8: Permission denied (publickey).' };
        return { code: 0, stdout: input.includes('TB_PUBLIC_KEY') ? 'TESTBOX_RESULT {"added":true}\n' : WORKER, stderr: '' };
      },
      () => json({ workers }),
    );
    try {
      const authorize = await run(['admin', 'authorize', 'ssh-ed25519 AAAAkey ana@laptop']);
      expect(authorize.code).toBe(1);
      expect(authorize.summary.error).toContain('1 of 2 workers did not get the key');
      const upgrade = await run(['admin', 'upgrade', '--no-control-plane']);
      expect(upgrade.code).toBe(1);
      expect(upgrade.summary.error).toContain('1 of 2 workers did not come back');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('exits 11 when the API does not answer or the worker sends no heartbeat', async () => {
    const result = 'TESTBOX_RESULT {"apiPort":3000,"redisPort":6379,"repoDir":"~/testbox/app","redisPasswordAdded":false}\n';
    const { home, run } = await adminHome(
      (input) => ({ code: 0, stdout: input.includes("TB_MODE='install'") ? WORKER : result, stderr: '' }),
      (url) => (url.pathname === '/v1/healthz' ? new Response('', { status: 502 }) : json({ workers: [{ id: 'box-1', healthy: false, labels: [] }] })),
    );
    try {
      const init = await fastClock(() => run(['admin', 'init-control-plane', 'me@10.0.0.5']));
      expect(init.code).toBe(11);
      expect(init.summary.error).toContain('cannot reach http://10.0.0.5:3000');
      expect((await fastClock(() => run(['admin', 'upgrade']))).code).toBe(11);
      const worker = await fastClock(() => run(['admin', 'add-worker', 'me@10.0.0.7', '--no-smoke']));
      expect(worker.code).toBe(11);
      expect(worker.summary.error).toContain('box-1 sent no heartbeat');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('ends add-worker with the exit code of a failed test job', async () => {
    const { home, run } = await adminHome(
      () => ({ code: 0, stdout: WORKER, stderr: '' }),
      () => json({ workers: [{ id: 'box-1', healthy: true, labels: ['linux'] }] }),
    );
    try {
      await writeUserConfig(home, { apiUrl: 'http://10.0.0.5:3000', token: 'tok', remoteRoot: '~/testbox' });
      const smoke = await run(['admin', 'add-worker', 'me@10.0.0.7']);
      expect(smoke.code).toBe(10);
      expect(smoke.summary.error).toContain('the test job failed (exit 10)');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
