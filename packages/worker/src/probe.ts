import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RuntimeFacts } from '@testbox/shared';

const execFileAsync = promisify(execFile);

export async function probeRuntime(): Promise<RuntimeFacts> {
  let xcodeVersion: string | null = null;
  // Xcode exists only on macOS. Skipping the spawn keeps Linux fingerprints stable.
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('xcodebuild', ['-version']);
      xcodeVersion = stdout.split('\n')[0]?.trim() || null;
    } catch {
      xcodeVersion = null;
    }
  }
  return {
    nodeVersion: process.version,
    arch: process.arch,
    platform: process.platform,
    xcodeVersion,
  };
}
