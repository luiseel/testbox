import type { JobSource } from '@testbox/shared';
import type { RemoteRunner } from './remote';

const MAX_LENGTH = 500;

/**
 * Read the path, git branch, commit, and dirty flag of a checkout.
 * When git fails (no repo, no git), the source has only the path. This never throws.
 */
export async function collectSource(runner: RemoteRunner, dir: string): Promise<JobSource> {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const result = await runner.run('git', ['-C', dir, ...args], { timeoutMs: 5_000 });
      return result.code === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const source: JobSource = { path: dir.slice(0, MAX_LENGTH) };
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return source;
  const commit = await git(['rev-parse', '--short', 'HEAD']);
  const status = await git(['status', '--porcelain']);
  if (branch) source.branch = branch.slice(0, MAX_LENGTH);
  if (commit) source.commit = commit.slice(0, MAX_LENGTH);
  if (status !== null) source.dirty = status.length > 0;
  return source;
}
