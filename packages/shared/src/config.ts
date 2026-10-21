import { readFile } from 'fs/promises';
import path from 'path';
import { parse } from 'yaml';
import { z } from 'zod';
import { SAFE_SEGMENT } from './paths';
import { JOB_SOURCE_MAX_LINKS } from './source';

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
  artifacts: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
  /** Other checkouts that are snapshotted next to this one; each lands in a sibling folder of this tree. */
  links: z
    .array(z.string().regex(SAFE_SEGMENT, { message: `a link name must match ${SAFE_SEGMENT.source}` }))
    .max(JOB_SOURCE_MAX_LINKS, { message: `a profile can have at most ${JOB_SOURCE_MAX_LINKS} links` })
    .default([])
    .refine((links) => new Set(links).size === links.length, { message: 'a link name is listed twice' }),
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

const configSchema = z
  .object({
    project: z.string().regex(SAFE_SEGMENT),
    sshHost: z.string().min(1).optional(),
    ignore: z.array(z.string()).default(DEFAULT_IGNORE),
    profiles: z.record(profileSchema).default({}),
  })
  .superRefine((config, ctx) => {
    // With links, the main tree is the folder <project> in the snapshot: a link of that name would overwrite it.
    for (const [name, profile] of Object.entries(config.profiles)) {
      if (profile.links.includes(config.project)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `profile ${name}: a link cannot have the project name ${config.project}` });
      }
    }
  });

/** testbox.yml is missing or invalid. The CLI exits 2 for it, not 1. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type ProfileConfig = z.infer<typeof profileSchema>;
export type TestboxConfig = z.infer<typeof configSchema>;

export function parseTestboxConfig(text: string): TestboxConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(`invalid testbox.yml: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`invalid testbox.yml: ${result.error.issues.map((i) => i.message).join('; ')}`);
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
  throw new ConfigError(`testbox.yml not found from ${startDir}; run testbox init in the repo root`);
}
