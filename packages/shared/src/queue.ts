export const QUEUE_NAME = 'jobs';

/** BullMQ treats a lower number as more urgent. Callers pass a higher-is-sooner priority. */
export function toBullPriority(userPriority: number): number {
  const clamped = Math.max(0, Math.min(999, Math.trunc(userPriority)));
  return 1000 - clamped;
}

export function bullConnection(redisUrl: string): { url: string; maxRetriesPerRequest: null } {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

export function bullPrefix(keyPrefix: string): string {
  return `${keyPrefix}:bull`;
}
