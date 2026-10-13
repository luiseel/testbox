import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BROWSER_BINARIES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'firefox',
  'microsoft-edge',
];

export function osLabel(platform: string): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return platform;
}

export function archLabel(arch: string): string {
  if (arch === 'x64' || arch === 'amd64') return 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  return arch;
}

/** `xcode` plus `xcode-<version>` from the first line of `xcodebuild -version`. */
export function xcodeLabels(versionLine: string | null): string[] {
  if (!versionLine) return [];
  const match = versionLine.match(/(\d+(?:\.\d+)*)/);
  const labels = ['xcode'];
  if (match?.[1]) labels.push(`xcode-${match[1]}`);
  return labels;
}

export function capabilityLabels(input: {
  platform: string;
  arch: string;
  xcodeVersion: string | null;
  iosSimulator: boolean;
  browser: boolean;
  pnpm: boolean;
  extra?: readonly string[];
}): string[] {
  const labels = [osLabel(input.platform), archLabel(input.arch), 'node'];
  if (input.pnpm) labels.push('pnpm');
  if (input.platform === 'darwin') {
    labels.push(...xcodeLabels(input.xcodeVersion));
    if (input.iosSimulator) labels.push('ios-simulator');
  }
  if (input.browser) labels.push('browser');
  for (const extra of input.extra ?? []) {
    const trimmed = extra.trim();
    if (trimmed && !labels.includes(trimmed)) labels.push(trimmed);
  }
  return labels;
}

export async function commandOnPath(name: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
  try {
    await execFileAsync('bash', ['-lc', `command -v ${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function hasIosSimulator(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'darwin') return false;
  try {
    await execFileAsync('xcrun', ['simctl', 'help'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectBrowser(exists: (name: string) => Promise<boolean> = commandOnPath): Promise<boolean> {
  for (const name of BROWSER_BINARIES) {
    if (await exists(name)) return true;
  }
  return false;
}
