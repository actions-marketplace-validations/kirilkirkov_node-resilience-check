import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { RequestSpec } from '../config/types.js';
import { buildHeaders, buildUrl, classifyError, type RequestErrorKind } from './request.js';

export type SlowReadOutcome =
  | { kind: 'completed'; status: number | null; bytes: number; durationMs: number }
  | { kind: 'error'; error: RequestErrorKind; message: string; bytes: number; durationMs: number };

export interface SlowReadOptions {
  holdMs: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

function serializeRequest(url: URL, spec: RequestSpec): string {
  const headers = {
    host: url.host,
    connection: 'close',
    ...buildHeaders(spec),
  };
  const lines = [`${spec.method} ${url.pathname}${url.search} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join('\r\n')}\r\n\r\n${spec.body?.data ?? ''}`;
}

/**
 * A deliberately slow HTTP client built on a raw socket: it sends the request
 * and then does not read at all for `holdMs`. The kernel buffers on both
 * sides fill up, so the server's writable stream starts returning false —
 * exactly the condition the backpressure check needs to observe.
 */
export function slowRead(
  baseUrl: string,
  spec: RequestSpec,
  options: SlowReadOptions,
): Promise<SlowReadOutcome> {
  const url = buildUrl(baseUrl, spec.path);
  const started = performance.now();

  return new Promise((resolve) => {
    let bytes = 0;
    let head = '';
    let settled = false;
    const socket = connect({ host: url.hostname, port: Number(url.port || 80) });
    // Paused before connecting, so libuv never starts reading from the socket.
    socket.pause();

    const finish = (outcome: SlowReadOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(holdTimer);
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(outcome);
    };
    const fail = (error: RequestErrorKind, message: string): void =>
      finish({ kind: 'error', error, message, bytes, durationMs: performance.now() - started });
    const onAbort = (): void => fail('aborted', 'aborted');

    const holdTimer = setTimeout(() => {
      socket.on('data', (chunk: Buffer) => {
        if (head.length < 64) head += chunk.subarray(0, 64).toString('latin1');
        bytes += chunk.length;
      });
      socket.resume();
    }, options.holdMs);
    const timeoutTimer = setTimeout(
      () => fail('timeout', `response not fully received within ${options.timeoutMs}ms`),
      options.timeoutMs,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });

    socket.once('connect', () => socket.write(serializeRequest(url, spec)));
    socket.once('error', (error) => fail(classifyError(error), error.message));
    socket.once('end', () => {
      const match = /^HTTP\/\d\.\d (\d{3})/.exec(head);
      finish({
        kind: 'completed',
        status: match?.[1] ? Number(match[1]) : null,
        bytes,
        durationMs: performance.now() - started,
      });
    });
  });
}
