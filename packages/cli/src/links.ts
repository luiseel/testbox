import type { Stats } from 'fs';
import { realpath, stat } from 'fs/promises';
import path from 'path';
import { loadRepoConfig, SAFE_SEGMENT, type TestboxConfig } from '@testbox/shared';

/** A link of a profile, found on disk: its name, its checkout, and the testbox.yml of that checkout. */
export interface LinkedCheckout {
  name: string;
  dir: string;
  loaded: { file: string; config: TestboxConfig };
}

/** A link that cannot be used. The CLI exits 2 for it: the call or the checkout layout is wrong, not the code. */
export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkError';
  }
}

/** Read the repeatable `--link <name>=<path>` flag. A relative path is relative to `cwd`. */
export function parseLinkFlags(values: readonly string[] | undefined, cwd: string): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const value of values ?? []) {
    const at = value.indexOf('=');
    const name = at > 0 ? value.slice(0, at) : '';
    const dir = at > 0 ? value.slice(at + 1) : '';
    if (!SAFE_SEGMENT.test(name) || !dir) throw new LinkError(`invalid --link ${value}: pass --link <name>=<path>`);
    if ([...overrides.keys()].some((other) => other.toLowerCase() === name.toLowerCase())) throw new LinkError(`--link ${name} is given twice`);
    overrides.set(name, path.resolve(cwd, dir));
  }
  return overrides;
}

/** The stat of a path, or null when there is nothing there. */
async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

/**
 * The places to look for the checkout of link `name`, in order: the `--link` path; for a
 * checkout folder `<project>_<suffix>`, the sibling `<name>_<suffix>`; the sibling `<name>`.
 */
export function linkCandidates(configDir: string, project: string, name: string, overrides: Map<string, string>): string[] {
  const override = overrides.get(name);
  if (override) return [override];
  const parent = path.dirname(configDir);
  const base = path.basename(configDir);
  const candidates: string[] = [];
  if (base.startsWith(`${project}_`) && base.length > project.length + 1) {
    candidates.push(path.join(parent, `${name}_${base.slice(project.length + 1)}`));
  }
  candidates.push(path.join(parent, name));
  return candidates;
}

/** Find the checkout of one link and load its testbox.yml. Throws LinkError when there is none. */
export async function resolveLink(
  configDir: string,
  project: string,
  name: string,
  overrides: Map<string, string>,
): Promise<LinkedCheckout> {
  const candidates = linkCandidates(configDir, project, name, overrides);
  let dir: string | null = null;
  for (const candidate of candidates) {
    if ((await statOrNull(candidate))?.isDirectory()) {
      dir = candidate;
      break;
    }
  }
  const shown = (candidate: string) => path.relative(configDir, candidate) || '.';
  if (!dir) {
    const fix = overrides.has(name) ? 'fix the path of --link' : `pass --link ${name}=<path>`;
    throw new LinkError(`link ${name}: no checkout at ${candidates.map(shown).join(' or ')}; ${fix}`);
  }
  if (await samePlace(dir, configDir)) throw new LinkError(`link ${name}: ${dir} is this checkout`);
  // loadRepoConfig looks in parent folders too; the linked checkout must have its own file.
  if (!(await statOrNull(path.join(dir, 'testbox.yml')))?.isFile()) {
    throw new LinkError(`link ${name}: ${dir} has no testbox.yml; run testbox init there`);
  }
  const loaded = await loadRepoConfig(dir);
  return { name, dir, loaded };
}

/** True when two paths name one directory, also through a symlink. */
export async function samePlace(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** The link in `others` whose checkout is the one of `link` (also through a symlink), or null. */
export async function sameCheckoutAs(link: LinkedCheckout, others: readonly LinkedCheckout[]): Promise<LinkedCheckout | null> {
  for (const other of others) {
    if (await samePlace(link.dir, other.dir)) return other;
  }
  return null;
}

/** Find every link in order. The first link that cannot be used throws; so do two links to one checkout. */
export async function resolveLinks(
  configDir: string,
  project: string,
  names: readonly string[],
  overrides: Map<string, string>,
): Promise<LinkedCheckout[]> {
  const links: LinkedCheckout[] = [];
  for (const name of names) {
    const link = await resolveLink(configDir, project, name, overrides);
    const other = await sameCheckoutAs(link, links);
    if (other) throw new LinkError(`link ${name}: ${link.dir} is the same checkout as link ${other.name}`);
    links.push(link);
  }
  return links;
}
