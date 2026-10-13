const BASE_ALLOW = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'NODE_OPTIONS',
  'PNPM_HOME',
  'DEVELOPER_DIR',
  'SSH_AUTH_SOCK',
  'XPC_SERVICE_NAME',
  'DISPLAY',
];

export function buildJobEnv(
  workerEnv: NodeJS.ProcessEnv,
  extraAllow: readonly string[],
  jobId: string,
): NodeJS.ProcessEnv {
  const allow = new Set([...BASE_ALLOW, ...extraAllow]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(workerEnv)) {
    if (value === undefined) continue;
    if (!allow.has(key)) continue;
    if (key.startsWith('TESTBOX_') || key === 'REDIS_URL') continue;
    env[key] = value;
  }
  env.TESTBOX_JOB_ID = jobId;
  return env;
}

export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  if (env.TESTBOX_WORKER_TOKEN) secrets.push(env.TESTBOX_WORKER_TOKEN);
  if (env.TESTBOX_BOOTSTRAP_TOKEN) secrets.push(env.TESTBOX_BOOTSTRAP_TOKEN);
  if (env.REDIS_URL) {
    try {
      const url = new URL(env.REDIS_URL);
      if (url.password) secrets.push(decodeURIComponent(url.password));
    } catch {
      // ignore unparsable URLs
    }
  }
  return secrets;
}
