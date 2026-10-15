import os from 'os';
import { ExitCode } from '@testbox/shared';
import { CliApiError, exitCodeForCliError, HttpApi } from './api-client';
import { BootstrapError, ipFromSshHost, repoRoot, runBootstrap } from './bootstrap';
import type { CliIO } from './commands';
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

const DEFAULT_REPO_DIR = '~/testbox/app';

/** A user name the API accepts (`^[a-z][a-z0-9-]{1,40}$`), from the local account name. */
export function defaultUserName(raw = os.userInfo().username): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 41);
  return cleaned.length >= 2 ? cleaned : 'admin-user';
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
      if (!address) {
        output.error(`pass --address <LAN IP of ${sshHost}>; workers and Twingate need an IP, not a .local name`);
        return ExitCode.JobFailed;
      }
      const repoDir = flags.repoDir ?? DEFAULT_REPO_DIR;
      output.info(`setting up the control plane on ${sshHost}`);
      const result = await runBootstrap<{ apiPort: number; redisPort: number; repoDir: string; redisPasswordAdded: boolean }>({
        runner: this.io.remote,
        sshHost,
        script: 'control-plane',
        env: {
          TB_REPO_DIR: repoDir,
          TB_GIT_URL: flags.gitUrl ?? (await this.gitUrl()),
          TB_GIT_REF: flags.ref ?? 'main',
          TB_API_PORT: flags.apiPort ?? '3000',
          TB_REDIS_PORT: flags.redisPort ?? '6379',
          TB_DATA_DIR: flags.dataDir ?? '~/testbox',
        },
        onProgress: (line) => output.info(`  ${line}`),
      });
      const apiUrl = `http://${address}:${result.apiPort}`;
      if (!(await this.waitHealthy(apiUrl))) {
        output.error(`the API runs on ${sshHost}, but this machine cannot reach ${apiUrl}. Check the firewall on ${sshHost}.`);
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
      output.summary({ ok: true, exitCode: 0 });
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
      } else {
        output.info(`token for ${name}. Send this command to them over a private channel:`);
        this.io.stdout.write(`testbox login --api-url ${apiUrl} --token ${token}\n`);
      }
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
    output.error(err instanceof Error ? err.message : 'failed');
    if (err instanceof CliApiError) return exitCodeForCliError(err) ?? ExitCode.JobFailed;
    return ExitCode.JobFailed;
  }
}
