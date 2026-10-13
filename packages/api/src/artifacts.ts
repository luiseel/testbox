import { createReadStream } from 'fs';
import { mkdir, readdir, stat, writeFile } from 'fs/promises';
import path from 'path';
import { AppError, resolveInside, writeRetention } from '@testbox/shared';
import type { Readable } from 'stream';

export async function saveArtifact(opts: {
  dataDir: string;
  jobId: string;
  relPath: string;
  body: Buffer;
  retentionUntil: number;
}): Promise<{ path: string; size: number }> {
  if (!/^job_[a-f0-9]{24}$/.test(opts.jobId)) {
    throw new AppError('NOT_FOUND', 'job not found', 404);
  }
  const root = path.join(opts.dataDir, 'artifacts', opts.jobId);
  let abs: string;
  try {
    abs = resolveInside(root, opts.relPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'illegal artifact path';
    throw new AppError('BAD_REQUEST', message, 400);
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, opts.body);
  await writeRetention(opts.dataDir, 'artifacts', opts.jobId, opts.retentionUntil);
  return { path: opts.relPath, size: opts.body.length };
}

export async function listArtifactFiles(dataDir: string, jobId: string): Promise<{ path: string; size: number }[]> {
  const root = path.join(dataDir, 'artifacts', jobId);
  const files: { path: string; size: number }[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, nextRel);
      else if (entry.isFile()) {
        const info = await stat(abs);
        files.push({ path: nextRel, size: info.size });
      }
    }
  }
  await walk(root, '');
  return files;
}

export function openArtifact(dataDir: string, jobId: string, relPath: string): Readable {
  let abs: string;
  try {
    abs = resolveInside(path.join(dataDir, 'artifacts', jobId), relPath);
  } catch {
    throw new AppError('BAD_REQUEST', 'illegal artifact path', 400);
  }
  return createReadStream(abs);
}

export function readRequestBody(req: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        reject(new AppError('BAD_REQUEST', 'artifact too large', 413));
        req.pause();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
