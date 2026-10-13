import { readFile } from 'fs/promises';
import path from 'path';
import { parse } from 'yaml';
import { z } from 'zod';

export const DEFAULT_IGNORE = [
  'node_modules',
  '.next',
  '.git',
  '.env',
  '.env.*',
  'dist',
  'build',
  'coverage',
  'DerivedData',
  '.turbo',
  '.testbox',
];

const profileObject = z.object({
  cmd: z.string().min(1),
  resources: z.enum(['light', 'exclusive']).default('light'),
  artifacts: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
});

/** `command` is accepted as an alias for `cmd` so the documented examples parse. */
const profileSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.cmd !== 'string' && typeof record.command === 'string') {
    return { ...record, cmd: record.command };
  }
  return value;
}, profileObject);

const configSchema = z.object({
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/),
  sshHost: z.string().min(1).optional(),
  ignore: z.array(z.string()).default(DEFAULT_IGNORE),
  profiles: z.record(profileSchema).default({}),
});

export type ProfileConfig = z.infer<typeof profileSchema>;
export type TestboxConfig = z.infer<typeof configSchema>;

export function parseTestboxConfig(text: string): TestboxConfig {
  const raw = parse(text);
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid testbox.yml: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

export async function loadRepoConfig(startDir: string): Promise<{ file: string; config: TestboxConfig }> {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'testbox.yml');
    try {
      const text = await readFile(candidate, 'utf8');
      return { file: candidate, config: parseTestboxConfig(text) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`testbox.yml not found from ${startDir}`);
}
