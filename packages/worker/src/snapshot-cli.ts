import { createSnapshot, DEFAULT_RETENTION_MS, type SnapshotLink } from '@testbox/shared';

/** Split `name=value`; the name is everything before the first `=`. */
function splitPair(flag: string, value: string): [string, string] {
  const at = value.indexOf('=');
  if (at <= 0) throw new Error(`${flag} needs NAME=VALUE`);
  return [value.slice(0, at), value.slice(at + 1)];
}

export async function runSnapshotCli(argv: string[]): Promise<number> {
  const ignore: string[] = [];
  const links = new Map<string, { stagingRel: string; ignore: string[] }>();
  const linkIgnores: [string, string][] = [];
  let dataDir = '';
  let stagingRel = '';
  let snapshotId = '';
  let workDir = '';
  let retentionMs = DEFAULT_RETENTION_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--ignore') {
      if (!next) throw new Error('--ignore needs a value');
      ignore.push(next);
      i++;
    } else if (arg === '--link') {
      if (!next) throw new Error('--link needs NAME=STAGING_REL');
      const [name, rel] = splitPair(arg, next);
      if (links.has(name)) throw new Error(`--link ${name} is given twice`);
      links.set(name, { stagingRel: rel, ignore: [] });
      i++;
    } else if (arg === '--link-ignore') {
      if (!next) throw new Error('--link-ignore needs NAME=PATTERN');
      linkIgnores.push(splitPair(arg, next));
      i++;
    } else if (arg === '--work-dir' && next) {
      workDir = next;
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
    throw new Error(
      'usage: snapshot-cli --data-dir DIR --staging-rel REL --snapshot-id ID [--ignore PATTERN] [--work-dir NAME --link NAME=REL [--link-ignore NAME=PATTERN]]',
    );
  }
  for (const [name, pattern] of linkIgnores) {
    const link = links.get(name);
    if (!link) throw new Error(`--link-ignore ${name}: no --link ${name}`);
    link.ignore.push(pattern);
  }
  if (links.size > 0 && !workDir) throw new Error('--link needs --work-dir');
  const snapshotLinks: SnapshotLink[] = [...links].map(([name, link]) => ({ name, ...link }));
  const result = await createSnapshot({
    dataDir,
    stagingRel,
    snapshotId,
    ignore,
    retentionMs,
    links: snapshotLinks,
    workDir: workDir || undefined,
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
