import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directoryDigest } from '@testbox/shared';
import { runSnapshotCli } from '../src/snapshot-cli';

describe('snapshot-cli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies each --link next to the main tree with its own --link-ignore and prints the work dir', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tb-snapcli-'));
    const mainRel = 'workspaces/usr_a/interface/ws_1';
    const apiRel = 'workspaces/usr_a/api/ws_2';
    await mkdir(path.join(dataDir, mainRel), { recursive: true });
    await mkdir(path.join(dataDir, apiRel), { recursive: true });
    await writeFile(path.join(dataDir, mainRel, 'main.txt'), 'main\n');
    await writeFile(path.join(dataDir, apiRel, 'api.txt'), 'api\n');
    await writeFile(path.join(dataDir, apiRel, 'secret.env'), 'x\n');
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const code = await runSnapshotCli([
        '--data-dir',
        dataDir,
        '--staging-rel',
        mainRel,
        '--snapshot-id',
        'snap_ffffffffffffffffffffffff',
        '--work-dir',
        'interface',
        '--link',
        `api=${apiRel}`,
        '--link-ignore',
        'api=*.env',
      ]);
      expect(code).toBe(0);
      const result = JSON.parse(written.join('')) as { digest: string; relPath: string; workDir: string };
      expect(result).toMatchObject({ relPath: 'snapshots/snap_ffffffffffffffffffffffff', workDir: 'interface' });
      const root = path.join(dataDir, result.relPath);
      expect(result.digest).toBe(await directoryDigest(root));
      expect(await readFile(path.join(root, 'interface', 'main.txt'), 'utf8')).toBe('main\n');
      expect(await readFile(path.join(root, 'api', 'api.txt'), 'utf8')).toBe('api\n');
      await expect(readFile(path.join(root, 'api', 'secret.env'))).rejects.toThrow();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a --link without --work-dir and a --link-ignore without its --link', async () => {
    const base = [
      '--data-dir',
      '/tmp/x',
      '--staging-rel',
      'workspaces/u/p/ws',
      '--snapshot-id',
      'snap_ffffffffffffffffffffffff',
    ];
    await expect(runSnapshotCli([...base, '--link', 'api=workspaces/u/api/ws'])).rejects.toThrow(
      '--link needs --work-dir',
    );
    await expect(runSnapshotCli([...base, '--link-ignore', 'api=*.env'])).rejects.toThrow('no --link api');
    await expect(runSnapshotCli([...base, '--link', 'api'])).rejects.toThrow('--link needs NAME=VALUE');
  });
});
