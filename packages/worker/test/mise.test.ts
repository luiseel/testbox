import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { capabilityLabels } from '../src/capabilities';
import { hasMiseConfig, MISE_CONFIG_FILES, miseEnv, miseExecArgv } from '../src/mise';

describe('mise', () => {
  it('finds each supported config file and nothing else', async () => {
    for (const name of MISE_CONFIG_FILES) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'mise-'));
      await writeFile(path.join(dir, name), '[tools]\n');
      expect(await hasMiseConfig(dir)).toBe(true);
      await rm(dir, { recursive: true, force: true });
    }
    const empty = await mkdtemp(path.join(os.tmpdir(), 'mise-'));
    await writeFile(path.join(empty, 'package.json'), '{}\n');
    expect(await hasMiseConfig(empty)).toBe(false);
    await rm(empty, { recursive: true, force: true });
  });

  it('trusts the data directory, answers yes, and wraps the command', () => {
    const env = miseEnv({ PATH: '/usr/bin', TESTBOX_JOB_ID: 'job_1' }, '/srv/testbox');
    expect(env).toEqual({
      PATH: '/usr/bin',
      TESTBOX_JOB_ID: 'job_1',
      MISE_YES: '1',
      MISE_TRUSTED_CONFIG_PATHS: '/srv/testbox',
    });
    expect(miseExecArgv(['bash', '-c', 'gradle test'])).toEqual(['mise', 'exec', '--', 'bash', '-c', 'gradle test']);
  });

  it('adds the mise label only when mise is on PATH', () => {
    const base = { platform: 'linux', arch: 'x64', xcodeVersion: null, iosSimulator: false, browser: false, pnpm: true };
    expect(capabilityLabels({ ...base, mise: true })).toEqual(['linux', 'x64', 'node', 'pnpm', 'mise']);
    expect(capabilityLabels({ ...base, mise: false })).not.toContain('mise');
  });
});
