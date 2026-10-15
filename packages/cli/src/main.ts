#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import type { EventEmitter } from 'events';
import { AdminApp, type InitControlPlaneFlags } from './admin';
import { TestboxApp, type CliIO } from './commands';
import { defaultSpawn } from './remote';

function defaultPrompt(question: string): Promise<string> {
  process.stderr.write(question);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => resolve(String(data)));
  });
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
    .requiredOption('--token <token>', 'API token')
    .requiredOption('--api-url <url>', 'API base URL')
    .option('--ssh-host <host>', 'ssh config host')
    .action(async (opts: { token: string; apiUrl: string; sshHost?: string }) => {
      code = await app.login(opts.token, opts.apiUrl, opts.sshHost);
    });

  common(program.command('start')).action(async (opts) => {
    code = await app.start(opts);
  });

  program.command('stop').action(async () => {
    code = await app.stop();
  });

  common(program.command('run').argument('<command>', 'command to run').option('--profile <name>', 'profile name'))
    .action(async (command: string, opts) => {
      code = await app.run(command, opts);
    });

  common(program.command('verify').argument('<profile>', 'profile from testbox.yml')).action(async (profile: string, opts) => {
    code = await app.verify(profile, opts);
  });

  program
    .command('status')
    .argument('<job-id>')
    .action(async (jobId: string) => {
      code = await app.status(jobId);
    });

  program
    .command('logs')
    .argument('<job-id>')
    .option('--follow', 'stream until the job finishes')
    .action(async (jobId: string, opts: { follow?: boolean }) => {
      code = await app.logs(jobId, Boolean(opts.follow));
    });

  program
    .command('cancel')
    .argument('<job-id>')
    .action(async (jobId: string) => {
      code = await app.cancel(jobId);
    });

  program
    .command('artifacts')
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
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
