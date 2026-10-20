/** The longest string the API accepts in a JobSource field. */
export const JOB_SOURCE_MAX_LENGTH = 500;

/** The checkout a job came from, as the CLI saw it when it submitted the job. */
export interface JobSource {
  path: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

/** Cut a source field to the accepted length and replace control characters, so the log line stays one line. */
export function cleanSourceField(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, JOB_SOURCE_MAX_LENGTH);
}

/** One log line that names the checkout, for example `source: /code/app main@3edf65d (dirty)`. */
export function formatJobSource(source: JobSource): string {
  const ref = [source.branch, source.commit].filter((part): part is string => Boolean(part)).map(cleanSourceField).join('@');
  const parts = ['source:', cleanSourceField(source.path)];
  if (ref) parts.push(ref);
  if (source.dirty) parts.push('(dirty)');
  return parts.join(' ');
}
