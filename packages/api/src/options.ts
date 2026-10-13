import os from 'os';
import path from 'path';
import { DEFAULT_RETENTION_MS } from '@testbox/shared';

export interface AppOptions {
  redisUrl: string;
  keyPrefix: string;
  dataDir: string;
  bootstrapToken?: string;
  workerToken?: string;
  leaseMs: number;
  heartbeatTtlMs: number;
  sweeperMs: number;
  retentionMs: number;
}

export const APP_OPTIONS = Symbol('APP_OPTIONS');
export const JOB_STORE = Symbol('JOB_STORE');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const EVENTS = Symbol('EVENTS');

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): AppOptions {
  return {
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    keyPrefix: env.TESTBOX_KEY_PREFIX ?? 'testbox',
    dataDir: env.TESTBOX_DATA_DIR ?? path.join(os.homedir(), 'testbox'),
    bootstrapToken: env.TESTBOX_BOOTSTRAP_TOKEN,
    workerToken: env.TESTBOX_WORKER_TOKEN,
    leaseMs: numberEnv(env.TESTBOX_LEASE_MS, 30_000),
    heartbeatTtlMs: numberEnv(env.TESTBOX_HEARTBEAT_TTL_MS, 15_000),
    sweeperMs: numberEnv(env.TESTBOX_SWEEPER_MS, 5_000),
    retentionMs: numberEnv(env.TESTBOX_RETENTION_MS, DEFAULT_RETENTION_MS),
  };
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
