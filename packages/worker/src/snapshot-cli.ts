import { createSnapshot, DEFAULT_RETENTION_MS } from '@testbox/shared';

export async function runSnapshotCli(argv: string[]): Promise<number> {
  const ignore: string[] = [];
  let dataDir = '';
  let stagingRel = '';
  let snapshotId = '';
  let retentionMs = DEFAULT_RETENTION_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--ignore') {
      if (!next) throw new Error('--ignore needs a value');
      ignore.push(next);
      i++;
    } else if (arg === '--data-dir' && next) {
      dataDir = next;
      i++;
    } else if (arg === '--staging-rel' && next) {
      stagingRel = next;
      i++;
    } else if (arg === '--snapshot-id' && next) {
      snapshotId = next;
      i++;
    } else if (arg === '--retention-ms' && next) {
      retentionMs = Number(next);
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!dataDir || !stagingRel || !snapshotId) {
    throw new Error('usage: snapshot-cli --data-dir DIR --staging-rel REL --snapshot-id ID [--ignore PATTERN]');
  }
  const result = await createSnapshot({
    dataDir,
    stagingRel,
    snapshotId,
    ignore,
    retentionMs,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (require.main === module) {
  runSnapshotCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
