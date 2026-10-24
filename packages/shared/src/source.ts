/** The longest string the API accepts in a JobSource field. */
export const JOB_SOURCE_MAX_LENGTH = 500;

/** One checkout as the CLI saw it: its path, and its git state when git works. */
export interface CheckoutSource {
  path: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

/** A linked checkout of a job: its name in testbox.yml `links`, and where the CLI found it. */
export interface JobSourceLink extends CheckoutSource {
  name: string;
}

/** The most links a profile, a `--link` list, or a job source may have. */
export const JOB_SOURCE_MAX_LINKS = 20;

/** The checkout a job came from, as the CLI saw it when it submitted the job. */
export interface JobSource extends CheckoutSource {
  /** The linked checkouts, when the profile has `links`. */
  links?: JobSourceLink[];
}

// oxlint-disable-next-line no-control-regex -- control characters are the thing to remove
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]+/g;

/** Cut a source field to the accepted length and replace control characters, so the log line stays one line. */
export function cleanSourceField(value: string): string {
  return value.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, JOB_SOURCE_MAX_LENGTH);
}

function formatRef(source: { branch?: string; commit?: string }): string {
  return [source.branch, source.commit].filter((part): part is string => Boolean(part)).map(cleanSourceField).join('@');
}

/**
 * One log line that names the checkout and its links, for example
 * `source: /code/app main@3edf65d (dirty) +api:main@91ab2c0(dirty)`.
 */
export function formatJobSource(source: JobSource): string {
  const ref = formatRef(source);
  const parts = ['source:', cleanSourceField(source.path)];
  if (ref) parts.push(ref);
  if (source.dirty) parts.push('(dirty)');
  for (const link of source.links ?? []) {
    const linkRef = formatRef(link);
    parts.push(`+${cleanSourceField(link.name)}${linkRef ? `:${linkRef}` : ''}${link.dirty ? '(dirty)' : ''}`);
  }
  return parts.join(' ');
}
