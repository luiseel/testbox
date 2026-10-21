/** The longest string the API accepts in a JobSource field. */
export const JOB_SOURCE_MAX_LENGTH = 500;

/** A linked checkout of a job: its name in testbox.yml `links`, and where the CLI found it. */
export interface JobSourceLink {
  name: string;
  path: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

/** The most links a job source may name. */
export const JOB_SOURCE_MAX_LINKS = 20;

/** The checkout a job came from, as the CLI saw it when it submitted the job. */
export interface JobSource {
  path: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  /** The linked checkouts, when the profile has `links`. */
  links?: JobSourceLink[];
}

/** Cut a source field to the accepted length and replace control characters, so the log line stays one line. */
export function cleanSourceField(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, JOB_SOURCE_MAX_LENGTH);
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
