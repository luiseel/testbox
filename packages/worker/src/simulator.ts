import { runCommand } from './executor';
import { buildJobEnv } from './env';

export interface SimulatorControl {
  reset(): Promise<void>;
}

export class MacOSSimulatorControl implements SimulatorControl {
  async reset(): Promise<void> {
    await runBestEffort(['xcrun', 'simctl', 'shutdown', 'all']);
    const erase = await runBestEffort(['xcrun', 'simctl', 'erase', 'all']);
    if (erase !== 0) {
      throw new Error(`simctl erase failed with exit ${erase}`);
    }
  }
}

async function runBestEffort(argv: string[]): Promise<number> {
  const result = await runCommand({
    cwd: process.cwd(),
    env: buildJobEnv(process.env, [], 'simulator-reset'),
    timeoutMs: 120_000,
    graceMs: 2_000,
    shell: { argv },
  });
  return result.exitCode ?? 1;
}

export function simulatorForPlatform(platform: NodeJS.Platform = process.platform): SimulatorControl {
  if (platform === 'darwin') return new MacOSSimulatorControl();
  return { async reset() {} };
}
