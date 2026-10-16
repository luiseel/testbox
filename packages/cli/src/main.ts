#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import type { EventEmitter } from 'events';
import { AdminApp, type AddWorkerFlags, type InitControlPlaneFlags, type UpgradeFlags } from './admin';
import { TestboxApp, type CliIO } from './commands';
import { DeveloperApp } from './developer';
import { defaultSpawn } from './remote';

function defaultPrompt(question: string): Promise<string> {
  process.stderr.write(question);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => resolve(String(data)));
  });
}

/**
 * On macOS a write to a pipe is asynchronous, and process.exit() drops what
 * is still buffered: `testbox verify … | tail` lost the last log lines.
 * Exit only after both streams have flushed.
 */
export function exitAfterFlush(
  code: number,
  streams: { write(chunk: string, cb: () => void): boolean }[] = [process.stdout, process.stderr],
  exit: (code: number) => void = (value) => process.exit(value),
): void {
  let pending = streams.length;
  for (const stream of streams) {
    stream.write('', () => {
      pending -= 1;
      if (pending === 0) exit(code);
    });
  }
}

export async function runCli(argv: string[], io: Partial<CliIO> = {}): Promise<number> {
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json');
  const full: CliIO = {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    cwd: io.cwd ?? process.cwd(),
    homeDir: io.homeDir ?? process.env.HOME ?? '',
    isTTY: io.isTTY ?? Boolean(process.stdin.isTTY),
    prompt: io.prompt ?? defaultPrompt,
    signals: io.signals ?? (process as unknown as EventEmitter),
    remote: io.remote ?? { run: defaultSpawn },
    fetchImpl: io.fetchImpl,
  };
  const app = new TestboxApp(full, json);
  const adminApp = new AdminApp(full, json);
  const developerApp = new DeveloperApp(full, json);
  let code = 0;
  const program = new Command();
  program.exitOverride();
  program.name('testbox').description('Run builds and tests on self-hosted macOS and Linux workers');

  const common = (command: Command) =>
    command
      .option('--timeout <seconds>', 'job timeout in seconds')
      .option('--priority <n>', 'higher runs sooner')
      .option('--workspace <id>', 'workspace id')
      .option('--direct', 'flush and run over SSH without the queue')
      .option('--detach', 'submit and return without waiting')
      .option('--ssh-host <host>', 'ssh config host');

  program
    .command('login')
    .description('store the API URL and token (testbox setup does this for you)')
    .requiredOption('--token <token>', 'API token')
    .requiredOption('--api-url <url>', 'API base URL')
    .option('--ssh-host <host>', 'ssh config host')
    .action(async (opts: { token: string; apiUrl: string; sshHost?: string }) => {
      code = await app.login(opts.token, opts.apiUrl, opts.sshHost);
    });

  program
    .command('setup')
    .description('set up this machine: Mutagen, login, SSH key, then testbox doctor')
    .requiredOption('--api-url <url>', 'API base URL (from your admin)')
    .requiredOption('--token <token>', 'API token (from your admin)')
    .action(async (opts: { apiUrl: string; token: string }) => {
      code = await developerApp.setup(opts.apiUrl, opts.token);
    });

  program
    .command('doctor')
    .description('check the API, Mutagen, each worker, and the profiles in testbox.yml')
    .action(async () => {
      code = await developerApp.doctor();
    });

  program
    .command('init')
    .description('write a starting testbox.yml for this repo')
    .option('--force', 'replace an existing testbox.yml')
    .action(async (opts: { force?: boolean }) => {
      code = await developerApp.init(Boolean(opts.force));
    });

  common(program.command('start').description('start syncing this repo to the workers'))
    .action(async (opts) => {
    code = await app.start(opts);
  });

  program.command('stop').description('stop syncing this repo').action(async () => {
    code = await app.stop();
  });

  common(
    program
      .command('run')
      .description('run a command on a worker')
      .argument('<command>', 'command to run')
      .option('--profile <name>', 'profile name'),
  )
    .action(async (command: string, opts) => {
      code = await app.run(command, opts);
    });

  common(program.command('verify').description('run a profile from testbox.yml on a worker').argument('<profile>', 'profile from testbox.yml'))
    .action(async (profile: string, opts) => {
    code = await app.verify(profile, opts);
  });

  program
    .command('status')
    .description('show the state of a job')
    .argument('<job-id>')
    .action(async (jobId: string) => {
      code = await app.status(jobId);
    });

  program
    .command('logs')
    .description('print the log of a job')
    .argument('<job-id>')
    .option('--follow', 'stream until the job finishes')
    .action(async (jobId: string, opts: { follow?: boolean }) => {
      code = await app.logs(jobId, Boolean(opts.follow));
    });

  program
    .command('cancel')
    .description('cancel a job')
    .argument('<job-id>')
    .action(async (jobId: string) => {
      code = await app.cancel(jobId);
    });

  program
    .command('artifacts')
    .description('download the artifacts of a job into .testbox/<job-id>/')
    .argument('<job-id>')
    .action(async (jobId: string) => {
      code = await app.artifacts(jobId);
    });

  const admin = program.command('admin').description('set up the control plane, workers, and users over SSH');

  admin
    .command('init-control-plane')
    .description('install or update the API and Redis on a host, then log in')
    .argument('<ssh-host>', 'user@host of the control-plane machine')
    .option('--address <ip>', 'LAN IP that workers and developers use (default: the host in <ssh-host>)')
    .option('--api-port <port>', 'API port', '3000')
    .option('--redis-port <port>', 'Redis port that workers connect to', '6379')
    .option('--repo-dir <dir>', 'checkout on the host', '~/testbox/app')
    .option('--data-dir <dir>', 'API data directory on the host', '~/testbox')
    .option('--git-url <url>', 'repo to clone (default: origin of this checkout)')
    .option('--ref <branch>', 'branch to deploy', 'main')
    .option('--user <name>', 'your user name on the API (default: your login name)')
    .action(async (sshHost: string, opts: InitControlPlaneFlags) => {
      code = await adminApp.initControlPlane(sshHost, opts);
    });

  admin
    .command('add-worker')
    .description('install or repair a worker on a host, wait for it, and run a test job on it')
    .argument('<ssh-host>', 'user@host of the worker machine')
    .option('--address <ip>', 'LAN IP that developers sync to (default: the host in <ssh-host>)')
    .option('--id <id>', 'worker id (default: <short hostname>-1)')
    .option('--capacity <n>', 'jobs at the same time', '1')
    .option('--labels <list>', 'extra labels, comma-separated')
    .option('--repo-dir <dir>', 'checkout on the host', '~/testbox/app')
    .option('--data-dir <dir>', 'worker data directory on the host', '~/testbox')
    .option('--git-url <url>', 'repo to clone (default: origin of this checkout)')
    .option('--ref <branch>', 'branch to deploy', 'main')
    .option('--wait <seconds>', 'how long to wait for the first heartbeat', '600')
    .option('--no-smoke', 'skip the test job')
    .action(async (sshHost: string, opts: AddWorkerFlags) => {
      code = await adminApp.addWorker(sshHost, opts);
    });

  admin
    .command('upgrade')
    .description('update the control plane, then pull, build, and restart every worker')
    .option('--git-url <url>', 'repo to pull (default: origin of this checkout)')
    .option('--ref <branch>', 'branch to deploy', 'main')
    .option('--no-control-plane', 'update the workers only')
    .action(async (opts: UpgradeFlags) => {
      code = await adminApp.upgrade(opts);
    });

  admin
    .command('authorize')
    .description("add a developer's SSH public key to every worker")
    .argument('<public-key>', 'one line, for example the content of ~/.ssh/id_ed25519.pub')
    .action(async (publicKey: string) => {
      code = await adminApp.authorize(publicKey);
    });

  admin
    .command('add-user')
    .description('create a user (or reuse it) and print a new token for them')
    .argument('<name>', 'lower case, for example ana or ci-bot')
    .action(async (name: string) => {
      code = await adminApp.addUser(name);
    });

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) return 0;
      full.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  return code;
}

if (require.main === module) {
  runCli(process.argv.slice(2))
    .then((code) => exitAfterFlush(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
