import { EventEmitter } from 'events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseTestboxConfig } from '@testbox/shared';
import { writeAdminConfig, writeUserConfig } from '../src/config-store';
import { runCli } from '../src/main';
import type { CommandResult, RemoteRunner } from '../src/remote';

function io(home: string, cwd: string, remote: RemoteRunner, fetchImpl: typeof fetch, out: string[]) {
  return {
    homeDir: home,
    cwd,
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => out.push(chunk) },
    remote,
    isTTY: false,
    signals: new EventEmitter(),
    prompt: async () => '',
    fetchImpl,
  };
}

const noRemote: RemoteRunner = {
  async run(): Promise<CommandResult> {
    return { code: 0, stdout: '', stderr: '' };
  },
};

describe('testbox init', () => {
  it('writes a valid testbox.yml with a profile per project it finds', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'tb-init-'));
    const out: string[] = [];
    try {
      await writeFile(path.join(repo, 'mise.toml'), '[tools]\njava = "temurin-25"\n');
      await writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
      await writeFile(path.join(repo, 'pnpm-lock.yaml'), '');
      await mkdir(path.join(repo, 'backend'));
      await writeFile(path.join(repo, 'backend', 'gradlew'), '');
      await mkdir(path.join(repo, 'client', 'swift-client'), { recursive: true });
      await writeFile(path.join(repo, 'client', 'swift-client', 'Package.swift'), '');
      await mkdir(path.join(repo, 'ios', 'App.xcodeproj'), { recursive: true });
      await mkdir(path.join(repo, 'node_modules', 'dep'), { recursive: true });
      await writeFile(
        path.join(repo, 'node_modules', 'dep', 'package.json'),
        JSON.stringify({ scripts: { test: 'x' } }),
      );

      expect(await runCli(['init'], io(repo, repo, noRemote, fetch, out))).toBe(0);
      const config = parseTestboxConfig(await readFile(path.join(repo, 'testbox.yml'), 'utf8'));
      expect(config.project).toBe(path.basename(repo));
      expect(Object.keys(config.profiles).sort()).toEqual(['backend', 'ios', 'swift-client', 'test']);
      expect(config.profiles.test).toMatchObject({ cmd: 'pnpm test', requires: ['mise'] });
      expect(config.profiles.backend).toMatchObject({
        cmd: 'cd backend && ./gradlew --no-daemon test',
        requires: ['mise'],
      });
      expect(config.profiles['swift-client']).toMatchObject({
        cmd: 'cd client/swift-client && swift test --build-system native',
        requires: ['macos'],
      });
      expect(config.profiles.ios).toMatchObject({ requires: ['macos', 'xcode', 'ios-simulator'] });
      expect(config.profiles.ios?.cmd).toContain('-project App.xcodeproj -scheme App');
      expect(config.ignore).toEqual(
        expect.arrayContaining(['.git', 'backend/.gradle', 'backend/build', 'client/swift-client/.build']),
      );

      expect(await runCli(['init'], io(repo, repo, noRemote, fetch, out))).toBe(1);
      expect(out.join('')).toContain('pass --force');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('testbox doctor', () => {
  it('tells a stopped control plane from a network problem when the API does not answer', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-doc-'));
    await writeUserConfig(home, { apiUrl: 'http://10.0.0.5:3000', token: 'tok', remoteRoot: '~/testbox' });
    const failing = (code: string) =>
      (async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
      }) as typeof fetch;
    const fixFor = async (fetchImpl: typeof fetch) => {
      const out: string[] = [];
      expect(await runCli(['doctor'], io(home, home, noRemote, fetchImpl, out))).toBe(11);
      const text = out.join('');
      expect(text).toContain('✗ API at http://10.0.0.5:3000');
      return text;
    };
    try {
      // Nothing listens on the port: the host is up, the containers are not.
      const refused = await fixFor(failing('ECONNREFUSED'));
      expect(refused).toContain('10.0.0.5:3000 is up, but the API is not running (ECONNREFUSED)');
      expect(refused).toContain('cd ~/testbox/app && docker compose up -d');
      expect(refused).not.toContain('VPN');

      // No answer at all: the network, or a stopped host. Say both.
      const unreachable = await fixFor(failing('ETIMEDOUT'));
      expect(unreachable).toContain('no answer from 10.0.0.5:3000 (ETIMEDOUT)');
      expect(unreachable).toContain('Turn on your VPN');
      expect(unreachable).toContain('cd ~/testbox/app && docker compose up -d');

      // The API answers, but not with 200: for example Redis is down behind it.
      const unhealthy = await fixFor((async () => new Response('', { status: 503 })) as typeof fetch);
      expect(unhealthy).toContain('the API answers HTTP 503 but is not healthy');
      expect(unhealthy).toContain('docker compose logs api');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports each problem with its fix', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-doc-'));
    const out: string[] = [];
    await writeUserConfig(home, { apiUrl: 'http://10.0.0.5:3000', token: 'tok', remoteRoot: '~/testbox' });
    await mkdir(path.join(home, '.ssh'));
    await writeFile(path.join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAAkey me@laptop\n');
    const repo = path.join(home, 'demo');
    await mkdir(repo);
    await writeFile(
      path.join(repo, 'testbox.yml'),
      'project: demo\nprofiles:\n  ios:\n    cmd: xcodebuild test\n    requires: [xcode]\n    links: [api, web]\n  unit:\n    cmd: make\n',
    );
    await mkdir(path.join(home, 'api'));
    await writeFile(path.join(home, 'api', 'testbox.yml'), 'project: api\n');
    const remote: RemoteRunner = {
      async run(file, args): Promise<CommandResult> {
        if (file === 'mutagen') return { code: 0, stdout: args[1] === 'list' ? '[]' : 'v0.18', stderr: '' };
        if (args.includes('me@10.0.0.7')) return { code: 0, stdout: '', stderr: '' };
        return { code: 255, stdout: '', stderr: 'me@10.0.0.8: Permission denied (publickey).' };
      },
    };
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = new URL(String(url));
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (target.pathname === '/v1/healthz') return json({ ok: true });
      if (target.pathname === '/v1/users/me') return json({ id: 'usr_1', name: 'ana', role: 'user' });
      if (target.pathname === '/v1/workers') {
        return json({
          workers: [
            { id: 'linux-1', healthy: true, labels: ['linux', 'worker:linux-1'], sshHost: 'me@10.0.0.7' },
            { id: 'mac-1', healthy: false, labels: ['macos', 'xcode'], sshHost: 'me@10.0.0.8' },
          ],
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
      expect(await runCli(['doctor'], io(home, repo, remote, fetchImpl, out))).toBe(1);
      const text = out.join('');
      expect(text).toContain('✓ logged in as ana');
      expect(text).toContain('✓ no stale syncs');
      expect(text).toContain('✓ linux-1 is up (linux)');
      expect(text).toContain('✓ SSH to me@10.0.0.7');
      expect(text).toContain('✗ mac-1 sends no heartbeat');
      expect(text).toContain("fix: send this to an admin: testbox admin authorize 'ssh-ed25519 AAAAkey me@laptop'");
      expect(text).toContain('✗ profile ios (requires xcode)');
      expect(text).toContain('only mac-1 can run it, and it is down');
      expect(text).toContain('✓ profile unit');
      expect(text).toContain(`✓ link api of ios: ${path.join(home, 'api')}`);
      expect(text).toContain(
        '✗ link web of ios: no checkout at ../web\n    fix: pass --link web=<path>, or clone it next to this checkout',
      );

      // Two links to one checkout (here through a symlink): verify rejects it, so doctor must say so.
      await symlink(path.join(home, 'api'), path.join(home, 'web'));
      out.length = 0;
      expect(await runCli(['doctor'], io(home, repo, remote, fetchImpl, out))).toBe(1);
      expect(out.join('')).toContain(
        `✗ link web of ios: ${path.join(home, 'web')} is the same checkout as link api\n    fix: give link web its own checkout (--link web=<path>), or remove it from the profile`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('testbox admin authorize', () => {
  it('adds one public key to every worker and rejects anything else', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-auth-'));
    const out: string[] = [];
    const inputs: string[] = [];
    const remote: RemoteRunner = {
      async run(_file, _args, opts): Promise<CommandResult> {
        const input = opts?.input ?? '';
        inputs.push(input);
        if (input.includes('Print the control-plane secrets')) {
          return {
            code: 0,
            stdout:
              'TESTBOX_RESULT {"workerToken":"w","bootstrapToken":"boot","redisPassword":"","apiPort":"3000","redisPort":"6379"}\n',
            stderr: '',
          };
        }
        return { code: 0, stdout: 'TESTBOX_RESULT {"added":true}\n', stderr: '' };
      },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ workers: [{ id: 'a-1', healthy: true, labels: [], sshHost: 'me@10.0.0.7' }] }), {
        status: 200,
      })) as typeof fetch;
    await writeAdminConfig(home, {
      controlPlane: {
        sshHost: 'me@10.0.0.5',
        address: '10.0.0.5',
        apiPort: 3000,
        redisPort: 6379,
        repoDir: '~/testbox/app',
      },
    });
    try {
      expect(await runCli(['admin', 'authorize', 'rm -rf /'], io(home, home, remote, fetchImpl, out))).toBe(2);
      expect(
        await runCli(['admin', 'authorize', 'ssh-ed25519 AAAAkey ana@laptop'], io(home, home, remote, fetchImpl, out)),
      ).toBe(0);
      expect(inputs.at(-1)).toContain("export TB_PUBLIC_KEY='ssh-ed25519 AAAAkey ana@laptop'");
      expect(out.join('')).toContain('a-1: key added');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
