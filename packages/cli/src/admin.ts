import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ExitCode } from '@testbox/shared';
import { HttpApi } from './api-client';
import { BootstrapError, ipFromSshHost, repoRoot, runBootstrap } from './bootstrap';
import { exitCodeForFailure, TestboxApp, UsageError, type CliIO } from './commands';
import { readAdminConfig, readUserConfig, writeAdminConfig, writeUserConfig, type AdminConfig } from './config-store';
import { Output } from './output';

export interface ControlPlaneSecrets {
  workerToken: string;
  bootstrapToken: string;
  redisPassword: string;
  apiPort: string;
  redisPort: string;
}

export interface InitControlPlaneFlags {
  address?: string;
  apiPort?: string;
  redisPort?: string;
  repoDir?: string;
  dataDir?: string;
  gitUrl?: string;
  ref?: string;
  user?: string;
}

export interface AddWorkerFlags {
  address?: string;
  id?: string;
  capacity?: string;
  labels?: string;
  repoDir?: string;
  dataDir?: string;
  gitUrl?: string;
  ref?: string;
  smoke?: boolean;
  wait?: string;
}

export interface UpgradeFlags {
  gitUrl?: string;
  ref?: string;
  controlPlane?: boolean;
}

interface WorkerResult {
  os: 'macos' | 'linux';
  workerId: string;
  xcode: boolean;
  localNetworkBlocked: boolean;
  node: string;
}

export const DEFAULT_GIT_REF = 'master';
const DEFAULT_REPO_DIR = '~/testbox/app';
const DEFAULT_DATA_DIR = '~/testbox';

/** REDIS_URL for a worker on another host. */
export function workerRedisUrl(address: string, port: number | string, password: string): string {
  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  return `redis://${auth}${address}:${port}`;
}

/** A user name the API accepts (`^[a-z][a-z0-9-]{1,40}$`), from the local account name. */
export function defaultUserName(raw = os.userInfo().username): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 41);
  return cleaned.length >= 2 ? cleaned : 'admin-user';
}

function noHeartbeat(workerId: string): string {
  return `${workerId} sent no heartbeat. Look at ~/testbox/logs/worker.stderr.log on that host.`;
}

export class AdminApp {
  constructor(
    private readonly io: CliIO,
    private readonly json: boolean,
  ) {}

  private out(): Output {
    return new Output(this.json, this.io.stdout, this.io.stderr);
  }

  async initControlPlane(sshHost: string, flags: InitControlPlaneFlags): Promise<number> {
    const output = this.out();
    try {
      const address = flags.address ?? ipFromSshHost(sshHost);
      if (!address) throw new UsageError(`pass --address <LAN IP of ${sshHost}>; workers and VPNs need an IP, not a .local name`);
      const repoDir = flags.repoDir ?? DEFAULT_REPO_DIR;
      output.info(`setting up the control plane on ${sshHost}`);
      const result = await runBootstrap<{ apiPort: number; redisPort: number; repoDir: string; redisPasswordAdded: boolean }>({
        runner: this.io.remote,
        sshHost,
        script: 'control-plane',
        env: {
          TB_REPO_DIR: repoDir,
          TB_GIT_URL: flags.gitUrl ?? (await this.gitUrl()),
          TB_GIT_REF: flags.ref ?? DEFAULT_GIT_REF,
          TB_API_PORT: flags.apiPort ?? '3000',
          TB_REDIS_PORT: flags.redisPort ?? '6379',
          TB_DATA_DIR: flags.dataDir ?? '~/testbox',
        },
        onProgress: (line) => output.info(`  ${line}`),
      });
      const apiUrl = `http://${address}:${result.apiPort}`;
      if (!(await this.waitHealthy(apiUrl))) {
        output.failure(`the API runs on ${sshHost}, but this machine cannot reach ${apiUrl}. Check the firewall on ${sshHost}.`, ExitCode.NoWorker);
        return ExitCode.NoWorker;
      }
      const admin: AdminConfig = {
        ...(await readAdminConfig(this.io.homeDir)),
        controlPlane: { sshHost, address, apiPort: result.apiPort, redisPort: result.redisPort, repoDir },
      };
      await writeAdminConfig(this.io.homeDir, admin);
      output.info(`control plane: ${apiUrl}`);

      const login = await readUserConfig(this.io.homeDir);
      if (login?.apiUrl === apiUrl && (await this.tokenWorks(apiUrl, login.token))) {
        output.info(`already logged in to ${apiUrl}`);
      } else {
        const name = flags.user ?? defaultUserName();
        const token = await this.issueUserToken(name);
        await writeUserConfig(this.io.homeDir, {
          ...(login ?? {}),
          apiUrl,
          token,
          remoteRoot: login?.remoteRoot ?? '~/testbox',
          snapshotBin: login?.snapshotBin ?? 'testbox/app/packages/worker/dist/snapshot-cli.js',
        });
        output.info(`logged in as ${name}`);
      }
      if (result.redisPasswordAdded) {
        output.info('Redis now has a password. Run `testbox admin add-worker <ssh-host>` again for each existing worker.');
      }
      output.info('next: testbox admin add-worker <user@worker-ip>');
      output.summary({ ok: true, exitCode: 0, exit: 0 });
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  async addUser(name: string): Promise<number> {
    const output = this.out();
    try {
      const token = await this.issueUserToken(name);
      const apiUrl = await this.apiUrl();
      if (this.json) {
        this.io.stdout.write(`${JSON.stringify({ type: 'user', name, apiUrl, token })}\n`);
        output.summary({ ok: true, exitCode: 0, exit: 0 });
      } else {
        output.info(`token for ${name}. Send this command to them over a private channel:`);
        this.io.stdout.write(`testbox setup --api-url ${apiUrl} --token ${token}\n`);
      }
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  async addWorker(sshHost: string, flags: AddWorkerFlags): Promise<number> {
    const output = this.out();
    try {
      const plane = await this.controlPlane();
      const address = flags.address ?? ipFromSshHost(sshHost);
      if (!address) throw new UsageError(`pass --address <LAN IP of ${sshHost}>; developers sync to the worker at this address`);
      const secrets = await this.secrets();
      output.info(`setting up the worker on ${sshHost}`);
      const result = await runBootstrap<WorkerResult>({
        runner: this.io.remote,
        sshHost,
        script: 'worker',
        env: {
          TB_MODE: 'install',
          TB_REPO_DIR: flags.repoDir ?? DEFAULT_REPO_DIR,
          TB_DATA_DIR: flags.dataDir ?? DEFAULT_DATA_DIR,
          TB_GIT_URL: flags.gitUrl ?? (await this.gitUrl()),
          TB_GIT_REF: flags.ref ?? DEFAULT_GIT_REF,
          TB_REDIS_URL: workerRedisUrl(plane.address, plane.redisPort ?? secrets.redisPort, secrets.redisPassword),
          TB_API_URL: await this.apiUrl(),
          TB_WORKER_TOKEN: secrets.workerToken,
          TB_WORKER_ID: flags.id ?? '',
          TB_ADDRESS: address,
          TB_CAPACITY: flags.capacity ?? '1',
          TB_LABELS: flags.labels ?? '',
        },
        onProgress: (line) => output.info(`  ${line}`),
      });
      if (result.os === 'macos' && !result.xcode) {
        output.info('no Xcode on this Mac: install it to get the xcode and ios-simulator labels');
      }
      const worker = await this.waitForWorker(result, Number(flags.wait ?? 600), output);
      if (!worker) {
        output.failure(noHeartbeat(result.workerId), ExitCode.NoWorker);
        return ExitCode.NoWorker;
      }
      output.info(`worker ${worker.id} is healthy: ${worker.labels.join(', ')}`);
      if (flags.smoke !== false) {
        const smoke = await this.smokeTest(worker.id, output);
        if (smoke !== ExitCode.Pass) return smoke;
      }
      output.summary({ ok: true, exitCode: 0, exit: 0 });
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  /** Update the control plane, then pull, build, and restart every registered worker. */
  async upgrade(flags: UpgradeFlags): Promise<number> {
    const output = this.out();
    try {
      const plane = await this.controlPlane();
      const gitUrl = flags.gitUrl ?? (await this.gitUrl());
      const ref = flags.ref ?? DEFAULT_GIT_REF;
      if (flags.controlPlane !== false) {
        output.info(`updating the control plane on ${plane.sshHost}`);
        await runBootstrap({
          runner: this.io.remote,
          sshHost: plane.sshHost,
          script: 'control-plane',
          env: {
            TB_REPO_DIR: plane.repoDir,
            TB_GIT_URL: gitUrl,
            TB_GIT_REF: ref,
            TB_API_PORT: String(plane.apiPort),
            TB_REDIS_PORT: String(plane.redisPort ?? 6379),
            TB_DATA_DIR: DEFAULT_DATA_DIR,
          },
          onProgress: (line) => output.info(`  ${line}`),
        });
        if (!(await this.waitHealthy(await this.apiUrl(), 30))) {
          output.failure('the API did not come back after the update', ExitCode.NoWorker);
          return ExitCode.NoWorker;
        }
      }
      const api = await this.adminApi();
      const workers = (await api.listWorkers()).filter((worker) => worker.sshHost);
      let failed = 0;
      for (const worker of workers) {
        output.info(`updating ${worker.id} (${worker.sshHost})`);
        try {
          await runBootstrap<WorkerResult>({
            runner: this.io.remote,
            sshHost: worker.sshHost as string,
            script: 'worker',
            env: {
              TB_MODE: 'upgrade',
              TB_REPO_DIR: DEFAULT_REPO_DIR,
              TB_DATA_DIR: DEFAULT_DATA_DIR,
              TB_GIT_URL: gitUrl,
              TB_GIT_REF: ref,
              TB_WORKER_ID: worker.id,
            },
            onProgress: (line) => output.info(`  ${line}`),
          });
        } catch (err) {
          failed += 1;
          output.error(`${worker.id}: ${err instanceof Error ? err.message : 'update failed'}`);
          continue;
        }
        const healthy = await this.waitForWorker({ workerId: worker.id }, 60, output);
        if (!healthy) {
          failed += 1;
          output.error(noHeartbeat(worker.id));
        }
      }
      if (failed > 0) {
        output.failure(`${failed} of ${workers.length} workers did not come back; run testbox admin add-worker for them`, ExitCode.JobFailed);
        return ExitCode.JobFailed;
      }
      output.info(`updated ${workers.length} worker${workers.length === 1 ? "" : "s"}`);
      output.summary({ ok: true, exitCode: 0, exit: 0 });
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  /** Add a developer's SSH public key to every registered worker. */
  async authorize(publicKey: string): Promise<number> {
    const output = this.out();
    try {
      const key = publicKey.trim();
      if (!/^(ssh-|ecdsa-|sk-)\S+ \S+( [^\n]*)?$/.test(key)) {
        throw new UsageError('expected one SSH public key line, for example the content of ~/.ssh/id_ed25519.pub');
      }
      const workers = (await (await this.adminApi()).listWorkers()).filter((worker) => worker.sshHost);
      let failed = 0;
      for (const worker of workers) {
        try {
          const result = await runBootstrap<{ added: boolean }>({
            runner: this.io.remote,
            sshHost: worker.sshHost as string,
            script: 'authorize-key',
            env: { TB_PUBLIC_KEY: key },
            timeoutMs: 60_000,
          });
          output.info(`${worker.id}: ${result.added ? 'key added' : 'key was already there'}`);
        } catch (err) {
          failed += 1;
          output.error(`${worker.id}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      }
      if (failed > 0) {
        output.failure(`${failed} of ${workers.length} workers did not get the key; fix SSH to them, then run this again`, ExitCode.JobFailed);
        return ExitCode.JobFailed;
      }
      output.summary({ ok: true, exitCode: 0, exit: 0 });
      return ExitCode.Pass;
    } catch (err) {
      return this.fail(output, err);
    }
  }

  /** Secrets live in .env on the control-plane host; read them over SSH when needed. */
  async secrets(): Promise<ControlPlaneSecrets> {
    const plane = await this.controlPlane();
    return runBootstrap<ControlPlaneSecrets>({
      runner: this.io.remote,
      sshHost: plane.sshHost,
      script: 'read-secrets',
      env: { TB_REPO_DIR: plane.repoDir },
      timeoutMs: 60_000,
    });
  }

  async controlPlane(): Promise<NonNullable<AdminConfig['controlPlane']>> {
    const admin = await readAdminConfig(this.io.homeDir);
    if (!admin.controlPlane) {
      throw new BootstrapError('no control plane yet; run testbox admin init-control-plane <user@host> first');
    }
    return admin.controlPlane;
  }

  async apiUrl(): Promise<string> {
    const plane = await this.controlPlane();
    return `http://${plane.address}:${plane.apiPort}`;
  }

  /** Create the user if needed, then issue a new token. Running it again gives a new token. */
  private async issueUserToken(name: string): Promise<string> {
    const secrets = await this.secrets();
    const api = new HttpApi(await this.apiUrl(), secrets.bootstrapToken, this.io.fetchImpl);
    const found = await api.findUser(name);
    const user = found.users[0] ?? (await api.createUser(name));
    return (await api.issueToken(user.id)).token;
  }

  private async adminApi(): Promise<HttpApi> {
    return new HttpApi(await this.apiUrl(), (await this.secrets()).bootstrapToken, this.io.fetchImpl);
  }

  /**
   * Wait for the first heartbeat. A Mac blocks the LaunchAgent from the LAN
   * until someone allows Local Network for node, so say how and keep waiting.
   */
  private async waitForWorker(
    result: Partial<WorkerResult> & { workerId: string },
    waitSeconds: number,
    output: Output,
  ): Promise<{ id: string; labels: string[] } | null> {
    const api = await this.adminApi();
    const started = Date.now();
    const deadline = started + Math.max(waitSeconds, 30) * 1000;
    let told = false;
    while (Date.now() < deadline) {
      const worker = (await api.listWorkers()).find((entry) => entry.id === result.workerId);
      if (worker?.healthy) return worker;
      if (!told && (result.localNetworkBlocked || (result.os === 'macos' && Date.now() - started > 20_000))) {
        told = true;
        output.info(
          `waiting for ${result.workerId}. macOS blocks the worker from the LAN until you allow it: on that Mac's screen, ` +
            'click Allow for "node", or turn on node in System Settings → Privacy & Security → Local Network.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return null;
  }

  /** A real job through sync, snapshot, queue, and run, which only this worker can take. */
  private async smokeTest(workerId: string, output: Output): Promise<number> {
    const login = await readUserConfig(this.io.homeDir);
    if (!login?.token || login.apiUrl !== (await this.apiUrl())) {
      output.info('skipping the test job: log in to this control plane first (testbox login)');
      return ExitCode.Pass;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'testbox-smoke-'));
    const lines: string[] = [];
    const sink = { write: (chunk: string) => lines.push(chunk) };
    const app = new TestboxApp({ ...this.io, cwd: dir, stdout: sink, stderr: sink }, false);
    try {
      await writeFile(
        path.join(dir, 'testbox.yml'),
        [
          'project: testbox-smoke',
          'profiles:',
          '  smoke:',
          '    command: echo "testbox ok on $(hostname)"',
          `    requires: ["worker:${workerId}"]`,
          '',
        ].join('\n'),
      );
      output.info(`running a test job on ${workerId}`);
      let code = await app.start({});
      if (code === ExitCode.Pass) code = await app.verify('smoke', { timeout: '300' });
      await app.stop().catch(() => ExitCode.Pass);
      if (code !== ExitCode.Pass) {
        output.failure(`the test job failed (exit ${code}):\n${lines.join('').trim()}`, code);
        return code;
      }
      const ok = lines.join('').split('\n').find((line) => line.startsWith('testbox ok on'));
      output.info(ok ?? 'test job passed');
      return ExitCode.Pass;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async tokenWorks(apiUrl: string, token: string): Promise<boolean> {
    try {
      await new HttpApi(apiUrl, token, this.io.fetchImpl).me();
      return true;
    } catch {
      return false;
    }
  }

  private async waitHealthy(apiUrl: string, attempts = 15): Promise<boolean> {
    const api = new HttpApi(apiUrl, '', this.io.fetchImpl);
    for (let i = 0; i < attempts; i++) {
      if (await api.healthy()) return true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  private async gitUrl(): Promise<string> {
    const result = await this.io.remote.run('git', ['-C', repoRoot(), 'remote', 'get-url', 'origin']);
    const url = result.stdout.trim();
    if (result.code !== 0 || !url) throw new BootstrapError('cannot read the git remote of this checkout; pass --git-url');
    return url;
  }

  private fail(output: Output, err: unknown): number {
    const code = exitCodeForFailure(err);
    output.failure(err instanceof Error ? err.message : 'failed', code);
    return code;
  }
}
