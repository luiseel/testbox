import os from 'os';
import path from 'path';
import { startDaemon } from './daemon';

function labelsFromEnv(env: NodeJS.ProcessEnv): string[] {
  if (env.TESTBOX_LABELS) {
    return env.TESTBOX_LABELS.split(',').map((label) => label.trim()).filter(Boolean);
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return ['macos', 'arm64', 'xcode', 'ios-simulator', 'node', 'pnpm', 'playwright'];
  }
  return [process.platform, process.arch, 'node'];
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const daemon = await startDaemon({
    redisUrl,
    keyPrefix: process.env.TESTBOX_KEY_PREFIX ?? 'testbox',
    dataDir: process.env.TESTBOX_DATA_DIR ?? path.join(os.homedir(), 'testbox'),
    workerId: process.env.TESTBOX_WORKER_ID ?? `${os.hostname()}-1`,
    labels: labelsFromEnv(process.env),
    hostname: os.hostname(),
    apiUrl: process.env.TESTBOX_API_URL,
    workerToken: process.env.TESTBOX_WORKER_TOKEN,
    processImmediately: true,
  });
  const shutdown = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
