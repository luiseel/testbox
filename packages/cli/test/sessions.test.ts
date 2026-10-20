import { EventEmitter } from 'events';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseMutagenSessions, type MutagenSessionInfo } from '@testbox/shared';
import { writeUserConfig, writeWorkspaceState, type WorkspaceState } from '../src/config-store';
import { runCli } from '../src/main';
import type { CommandResult, RemoteRunner } from '../src/remote';
import { classifySessions, type RootState } from '../src/sessions';

// Captured from Mutagen 0.18.1 (`mutagen sync list --template '{{json .}}'`): one session
// while it watched, then the same session after its alpha directory was deleted.
const WATCHING = `[{"identifier":"sync_4QurjcOQmZlTGzLs7YscCAvaZFgyrOmp68FDbCxq74X","version":1,"creationTime":"2026-10-20T00:34:28.947442Z","creatingVersion":"0.18.1","alpha":{"protocol":"local","path":"/private/tmp/probe/a","ignore":{},"symlink":{},"watch":{},"permissions":{},"compression":{},"connected":true,"scanned":true,"directories":1,"files":1,"totalFileSize":3},"beta":{"protocol":"local","path":"/private/tmp/probe/b","ignore":{},"symlink":{},"watch":{},"permissions":{},"compression":{},"connected":true,"scanned":true,"directories":1,"files":1,"totalFileSize":3},"mode":"one-way-replica","ignore":{},"symlink":{},"watch":{},"permissions":{},"compression":{},"name":"testbox-probe-xyz","paused":false,"status":"watching","successfulCycles":3}]
`;
const HALTED = `[{"identifier":"sync_4QurjcOQmZlTGzLs7YscCAvaZFgyrOmp68FDbCxq74X","version":1,"creationTime":"2026-10-20T00:34:28.947442Z","creatingVersion":"0.18.1","alpha":{"protocol":"local","path":"/private/tmp/probe/a","ignore":{},"symlink":{},"watch":{},"permissions":{},"compression":{},"connected":true,"scanned":true},"beta":{"protocol":"local","path":"/private/tmp/probe/b","ignore":{},"symlink":{},"watch":{},"permissions":{},"compression":{},"connected":true,"scanned":true,"directories":1,"files":1,"totalFileSize":3},"mode":"one-way-replica","ignore":{},"symlink":{},"watch":{},"permissions":{},"compression":{},"name":"testbox-probe-xyz","paused":false,"status":"halted-on-root-deletion","successfulCycles":3}]
`;

/** A list entry in the shape Mutagen 0.18 prints, with an SSH beta like the ones testbox start creates. */
function entry(name: string, alpha: string, beta = '~/testbox/workspaces/local/demo'): Record<string, unknown> {
  return {
    identifier: `sync_${name}`,
    alpha: { protocol: 'local', path: alpha, connected: true },
    beta: { protocol: 'ssh', user: 'me', host: '10.0.0.7', path: beta, connected: true },
    mode: 'one-way-replica',
    name,
    paused: false,
    status: 'watching',
  };
}

function state(dir: string, sessionName: string, workerSessions: Record<string, string> = {}): WorkspaceState {
  return {
    id: 'ws_1',
    project: 'demo',
    sessionName,
    stagingRel: 'workspaces/local/demo',
    sshHost: 'me@10.0.0.7',
    remoteRoot: '~/testbox',
    direct: false,
    configDir: dir,
    sessions: Object.fromEntries(Object.entries(workerSessions).map(([id, name]) => [id, { sessionName: name, sshHost: 'me@10.0.0.7' }])),
  };
}

function io(home: string, remote: RemoteRunner, out: string[], err: string[] = out) {
  return {
    homeDir: home,
    cwd: home,
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    remote,
    isTTY: false,
    signals: new EventEmitter(),
    prompt: async () => '',
    fetchImpl: (async () => {
      throw new Error('prune must not call the API');
    }) as typeof fetch,
  };
}

/** A fake mutagen: `sync list` prints the given sessions, `sync terminate` records the name. */
function fakeMutagen(list: Record<string, unknown>[], failTerminate: string[] = []) {
  const terminated: string[] = [];
  const remote: RemoteRunner = {
    async run(file, args): Promise<CommandResult> {
      if (file !== 'mutagen') return { code: 1, stdout: '', stderr: `unexpected ${file}` };
      if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(list), stderr: '' };
      if (args[1] === 'terminate') {
        const name = args[2] ?? '';
        if (failTerminate.includes(name)) return { code: 1, stdout: '', stderr: 'unable to locate requested sessions' };
        terminated.push(name);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'v0.18.1', stderr: '' };
    },
  };
  return { remote, terminated };
}

describe('parseMutagenSessions', () => {
  it('reads the name, roots, and status of a watching and a halted session', () => {
    const expected = {
      name: 'testbox-probe-xyz',
      alphaPath: '/private/tmp/probe/a',
      betaUrl: '/private/tmp/probe/b',
      paused: false,
    };
    expect(parseMutagenSessions(WATCHING)).toEqual([{ ...expected, status: 'watching' }]);
    expect(parseMutagenSessions(HALTED)).toEqual([{ ...expected, status: 'halted-on-root-deletion' }]);
    expect(parseMutagenSessions('[]\n')).toEqual([]);
  });

  it('writes an SSH destination as user@host:path', () => {
    expect(parseMutagenSessions(JSON.stringify([entry('testbox-a', '/src/a', '~/testbox/w')]))[0]?.betaUrl).toBe('me@10.0.0.7:~/testbox/w');
  });
});

describe('classifySessions', () => {
  it('finds deleted roots, unowned syncs, live syncs, and live syncs that share a destination', async () => {
    const session = (name: string, alpha: string, beta = 'me@w:~/testbox/workspaces/local/demo'): MutagenSessionInfo => ({
      name,
      alphaPath: alpha,
      betaUrl: beta,
      status: 'watching',
      paused: false,
    });
    const roots: Record<string, RootState> = {
      '/gone': 'missing',
      '/plain': null,
      '/a': state('/a', 'testbox-demo-a', { 'mac-1': 'testbox-demo-a-mac-1' }),
      '/b': state('/b', 'testbox-demo-b'),
    };
    const report = await classifySessions(
      [
        session('testbox-demo-old', '/gone'),
        session('testbox-demo-x', '/plain'),
        session('testbox-demo-a', '/a'),
        session('testbox-demo-a-mac-1', '/a', 'me@mac:~/testbox/workspaces/local/demo'),
        session('testbox-demo-a-again', '/a'),
        session('testbox-demo-b', '/b'),
        session('other-project', '/gone'),
      ],
      async (root) => (root in roots ? (roots[root] as RootState) : 'missing'),
    );
    expect(report.sessions.map((entry) => [entry.session.name, entry.kind])).toEqual([
      ['testbox-demo-old', 'missing-root'],
      ['testbox-demo-x', 'unowned'],
      ['testbox-demo-a', 'live'],
      ['testbox-demo-a-mac-1', 'live'],
      ['testbox-demo-a-again', 'unowned'],
      ['testbox-demo-b', 'live'],
    ]);
    expect(report.conflicts).toEqual([
      { betaUrl: 'me@w:~/testbox/workspaces/local/demo', roots: ['/a', '/b'], sessions: ['testbox-demo-a', 'testbox-demo-b'] },
    ]);
  });
});

describe('testbox prune and doctor', () => {
  async function checkouts() {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tb-prune-'));
    const live = path.join(home, 'live');
    const plain = path.join(home, 'plain');
    await mkdir(plain);
    await writeWorkspaceState(live, state(live, 'testbox-demo-live'));
    const list = [
      entry('testbox-demo-live', live),
      entry('testbox-demo-dup', live),
      entry('testbox-demo-plain', plain),
      entry('testbox-demo-gone', path.join(home, 'deleted')),
      entry('someone-else', path.join(home, 'deleted')),
    ];
    return { home, live, plain, list };
  }

  it('terminates only the stale testbox syncs and reports a failed terminate', async () => {
    const { home, list } = await checkouts();
    const { remote, terminated } = fakeMutagen(list, ['testbox-demo-plain']);
    const out: string[] = [];
    const err: string[] = [];
    try {
      expect(await runCli(['prune'], io(home, remote, out, err))).toBe(10);
      expect(terminated).toEqual(['testbox-demo-dup', 'testbox-demo-gone']);
      const text = out.join('');
      expect(text).toContain(`terminated testbox-demo-gone (root deleted: ${path.join(home, 'deleted')})`);
      expect(text).toContain('terminated testbox-demo-dup (no workspace owns it');
      expect(text).toContain('2 stale syncs terminated');
      expect(err.join('')).toContain('could not terminate testbox-demo-plain: unable to locate requested sessions');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('--dry-run prints the stale syncs and terminates nothing', async () => {
    const { home, list } = await checkouts();
    const { remote, terminated } = fakeMutagen(list);
    const out: string[] = [];
    try {
      expect(await runCli(['prune', '--dry-run'], io(home, remote, out))).toBe(0);
      expect(terminated).toEqual([]);
      const text = out.join('');
      expect(text).toContain('would terminate testbox-demo-plain');
      expect(text).not.toContain('testbox-demo-live');
      expect(text).toContain('3 stale syncs to terminate');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('doctor names each stale sync and each shared destination with its fix', async () => {
    const { home, live, list } = await checkouts();
    const other = path.join(home, 'other');
    await writeWorkspaceState(other, state(other, 'testbox-demo-other'));
    const { remote } = fakeMutagen([...list, entry('testbox-demo-other', other)]);
    const out: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/v1/healthz') return new Response('{"ok":true}');
      if (pathname === '/v1/users/me') return new Response('{"id":"usr_1","name":"ana","role":"user"}');
      if (pathname === '/v1/workers') return new Response('{"workers":[]}');
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    await writeUserConfig(home, { apiUrl: 'http://10.0.0.5:3000', token: 'tok' });
    try {
      expect(await runCli(['doctor'], { ...io(home, remote, out), fetchImpl })).toBe(1);
      const text = out.join('');
      expect(text).toContain(`✗ sync testbox-demo-gone (root deleted: ${path.join(home, 'deleted')})\n    fix: testbox prune`);
      expect(text).toContain(`✗ sync testbox-demo-plain (no workspace owns it: ${path.join(home, 'plain')})`);
      expect(text).not.toContain('someone-else');
      expect(text).toContain(`✗ syncs from ${live} and ${other} write to the same worker folder me@10.0.0.7:~/testbox/workspaces/local/demo`);
      expect(text).toContain('fix: run testbox stop in the checkout you do not use');
      expect(text).not.toContain('no stale syncs');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
