import { readFile } from 'fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const workerFileSchema = z.object({
  capacity: z.number().int().min(1).max(64).optional(),
  sshHost: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).default([]),
});

export type WorkerFileConfig = z.infer<typeof workerFileSchema>;

export function parseWorkerConfig(text: string): WorkerFileConfig {
  const raw = parse(text) ?? {};
  const result = workerFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid worker config: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return result.data;
}

export async function readWorkerConfigFile(file: string): Promise<WorkerFileConfig | null> {
  try {
    return parseWorkerConfig(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
