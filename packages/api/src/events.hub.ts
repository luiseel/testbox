import type { JobEvent } from '@testbox/shared';
import IORedis from 'ioredis';

export class EventsHub {
  private readonly sub: IORedis;
  private readonly listeners = new Set<(event: JobEvent) => void>();
  private started = false;

  constructor(
    redisUrl: string,
    private readonly prefix: string,
  ) {
    this.sub = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.sub.subscribe(`${this.prefix}:events`);
    this.sub.on('message', (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message) as JobEvent;
        for (const listener of this.listeners) listener(event);
      } catch {
        // ignore malformed events
      }
    });
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    await this.sub.quit();
  }
}
