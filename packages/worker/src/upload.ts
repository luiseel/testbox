import { readFile } from 'fs/promises';

export async function uploadArtifacts(opts: {
  apiUrl: string;
  token: string;
  jobId: string;
  files: { relPath: string; absPath: string }[];
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const file of opts.files) {
    const body = await readFile(file.absPath);
    const response = await fetchImpl(`${opts.apiUrl.replace(/\/$/, '')}/v1/jobs/${opts.jobId}/artifacts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.token}`,
        'content-type': 'application/octet-stream',
        'x-artifact-path': file.relPath,
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`artifact upload failed for ${file.relPath}: ${response.status}`);
    }
  }
}
