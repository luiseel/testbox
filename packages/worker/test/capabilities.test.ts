import { describe, expect, it } from 'vitest';
import { capabilityLabels, detectBrowser, xcodeLabels } from '../src/capabilities';
import { probeRuntime } from '../src/probe';

describe('worker capabilities', () => {
  it('detects linux and x64 without Xcode or the simulator', async () => {
    const labels = capabilityLabels({
      platform: 'linux',
      arch: 'x64',
      xcodeVersion: 'Xcode 16.2',
      iosSimulator: true,
      browser: true,
      pnpm: true,
      extra: ['gpu', 'linux'],
    });
    expect(labels).toEqual(['linux', 'x64', 'node', 'pnpm', 'browser', 'gpu']);
    expect(labels).not.toContain('xcode');
    expect(labels).not.toContain('ios-simulator');
    if (process.platform !== 'darwin') {
      expect((await probeRuntime()).xcodeVersion).toBeNull();
      expect(await detectBrowser(async () => false)).toBe(false);
    }
  });

  it('detects macos toolchains and keeps custom labels', () => {
    expect(xcodeLabels('Xcode 16.2')).toEqual(['xcode', 'xcode-16.2']);
    const labels = capabilityLabels({
      platform: 'darwin',
      arch: 'arm64',
      xcodeVersion: 'Xcode 16.2',
      iosSimulator: true,
      browser: false,
      pnpm: true,
      extra: ['large-disk'],
    });
    expect(labels).toEqual(['macos', 'arm64', 'node', 'pnpm', 'xcode', 'xcode-16.2', 'ios-simulator', 'large-disk']);
  });
});