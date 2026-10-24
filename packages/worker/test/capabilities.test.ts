import { describe, expect, it } from 'vitest';
import { capabilityLabels, detectBrowser, detectTools, xcodeLabels } from '../src/capabilities';
import { probeRuntime } from '../src/probe';

describe('worker capabilities', () => {
  it('detects linux and x64 without Xcode or the simulator', async () => {
    const labels = capabilityLabels({
      platform: 'linux',
      arch: 'x64',
      xcodeVersion: 'Xcode 16.2',
      iosSimulator: true,
      browser: true,
      tools: ['pnpm', 'docker'],
      extra: ['gpu', 'linux'],
    });
    expect(labels).toEqual(['linux', 'x64', 'node', 'pnpm', 'docker', 'browser', 'gpu']);
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
      tools: ['xcodegen', 'pnpm'],
      extra: ['large-disk'],
    });
    expect(labels).toEqual([
      'macos',
      'arm64',
      'node',
      'pnpm',
      'xcodegen',
      'xcode',
      'xcode-16.2',
      'ios-simulator',
      'large-disk',
    ]);
  });

  it('labels the tools it finds on PATH, in a fixed order', async () => {
    const onPath = new Set(['docker', 'xcodegen', 'mise', 'pnpm']);
    expect(await detectTools(async (name) => onPath.has(name))).toEqual(['pnpm', 'mise', 'xcodegen', 'docker']);
    expect(await detectTools(async (name) => name === 'docker')).toEqual(['docker']);
    expect(await detectTools(async () => false)).toEqual([]);
  });
});
