import os from 'os';
import path from 'path';
import { readWorkerConfigFile } from '@testbox/shared';
import { capabilityLabels, commandOnPath, detectBrowser, hasIosSimulator } from './capabilities';
import { startDaemon } from './daemon';
import { probeRuntime } from './probe';

function extraLabels(env: NodeJS.ProcessEnv): string[] {
  if (!env.TESTBOX_LABELS) return [];
  return env.TESTBOX_LABELS.split(',').map((label) => label.trim()).filter(Boolean);
}

function numberFrom(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
}

async function loadLabels(env: NodeJS.ProcessEnv, dataDir: string): Promise<{
  labels: string[];
  capacity?: number;
  sshHost?: string;
}> {
  const configPath = env.TESTBOX_WORKER_CONFIG;
  const file = configPath
    ? await readWorkerConfigFile(configPath)
    : await readWorkerConfigFile(path.join(dataDir, 'worker.yml'));
  if (configPath && !file) throw new Error(`worker config not found: ${configPath}`);
  const runtime = await probeRuntime();
  const labels = capabilityLabels({
    platform: process.platform,
    arch: process.arch,
    xcodeVersion: runtime.xcodeVersion,
    iosSimulator: await hasIosSimulator(),
    browser: await detectBrowser(),
    pnpm: await commandOnPath('pnpm'),
    extra: [...extraLabels(env), ...(file?.labels ?? [])],
  });
  return { labels, capacity: file?.capacity, sshHost: file?.sshHost };
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const dataDir = process.env.TESTBOX_DATA_DIR ?? path.join(os.homedir(), 'testbox');
  const detected = await loadLabels(process.env, dataDir);
  const daemon = await startDaemon({
    redisUrl,
    keyPrefix: process.env.TESTBOX_KEY_PREFIX ?? 'testbox',
    dataDir,
    workerId: process.env.TESTBOX_WORKER_ID ?? `${os.hostname()}-1`,
    labels: detected.labels,
    hostname: os.hostname(),
    capacity: numberFrom(process.env.TESTBOX_CAPACITY, detected.capacity ?? 1),
    sshHost: process.env.TESTBOX_SSH_HOST ?? detected.sshHost ?? null,
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
