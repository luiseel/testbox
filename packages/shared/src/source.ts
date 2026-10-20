/** The checkout a job came from, as the CLI saw it when it submitted the job. */
export interface JobSource {
  path: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

/** One log line that names the checkout, for example `source: /code/app main@3edf65d (dirty)`. */
export function formatJobSource(source: JobSource): string {
  const ref = [source.branch, source.commit].filter((part) => part).join('@');
  const parts = ['source:', source.path];
  if (ref) parts.push(ref);
  if (source.dirty) parts.push('(dirty)');
  return parts.join(' ');
}
