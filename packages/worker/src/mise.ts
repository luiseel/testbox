import { access } from 'fs/promises';
import path from 'path';

export const MISE_CONFIG_FILES = ['mise.toml', '.mise.toml', '.tool-versions'];

export async function hasMiseConfig(dir: string): Promise<boolean> {
  for (const name of MISE_CONFIG_FILES) {
    try {
      await access(path.join(dir, name));
      return true;
    } catch {
      // try the next name
    }
  }
  return false;
}

/**
 * Each job runs in a new snapshot directory, so mise would ask to trust its
 * config every time. Trust everything under the worker data directory and
 * answer yes to prompts, because no one is at the terminal.
 */
export function miseEnv(env: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  return { ...env, MISE_YES: '1', MISE_TRUSTED_CONFIG_PATHS: dataDir };
}

/** argv that runs `command` with the snapshot's mise tools on `PATH`. */
export function miseExecArgv(argv: readonly string[]): string[] {
  return ['mise', 'exec', '--', ...argv];
}
