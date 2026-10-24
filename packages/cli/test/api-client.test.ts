import { describe, expect, it } from 'vitest';
import { ApiUnreachableError, HttpApi, isAbort } from '../src/api-client';

describe('HttpApi transport errors', () => {
  it('reports a connection that drops mid-stream as unreachable, not as a failed job', async () => {
    // One event arrives, then the socket resets on the next read.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode('event: status\ndata: {"state":"running"}\n\n'));
          return;
        }
        const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        controller.error(new TypeError('terminated', { cause: reset }));
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const api = new HttpApi('http://api.test', 'tok', fetchImpl);
    const events: string[] = [];
    const err: unknown = await api
      .stream('job_1', (event) => events.push(event), new AbortController().signal)
      .catch((e: unknown) => e);
    expect(events).toEqual(['status']);
    expect(err).toBeInstanceOf(ApiUnreachableError);
    expect((err as Error).message).toBe('cannot reach the API at http://api.test: ECONNRESET');
  });

  it('passes an abort by the caller through unchanged', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    const api = new HttpApi('http://api.test', 'tok', fetchImpl);
    const err: unknown = await api.getJob('job_1').catch((e: unknown) => e);
    expect(isAbort(err)).toBe(true);
    expect(err).not.toBeInstanceOf(ApiUnreachableError);
  });

  it('names an API address that is not a URL without throwing', () => {
    const err = new ApiUnreachableError('10.0.0.5:3000', new Error('Invalid URL'));
    expect(err.message).toBe('cannot reach the API at 10.0.0.5:3000: Invalid URL');
  });
});
