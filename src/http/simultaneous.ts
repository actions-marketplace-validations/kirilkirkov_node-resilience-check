import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestSpec } from '../config/types.js';
import { classifyError, sendRequest, type RequestOutcome } from './request.js';

function openSocket(url: URL, timeoutMs: number): Promise<Socket | Error> {
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 80) });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(new Error(`connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve(error);
    });
  });
}

export interface SimultaneousOptions {
  /** One entry per request; 0 means "fire at the barrier". */
  delaysMs: number[];
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/**
 * Opens every connection first and only then writes all requests in the same
 * tick, so the server sees them within microseconds of each other instead of
 * being spread out by TCP handshakes.
 */
export async function sendSimultaneously(
  baseUrl: string,
  spec: RequestSpec,
  options: SimultaneousOptions,
): Promise<RequestOutcome[]> {
  const url = new URL(baseUrl);
  const sockets = await Promise.all(options.delaysMs.map(() => openSocket(url, options.timeoutMs)));

  try {
    return await Promise.all(
      sockets.map(async (socket, index): Promise<RequestOutcome> => {
        if (socket instanceof Error) {
          return {
            kind: 'error',
            error: classifyError(socket),
            message: socket.message,
            durationMs: 0,
          };
        }
        const wait = options.delaysMs[index] ?? 0;
        if (wait > 0) {
          try {
            await delay(wait, undefined, { signal: options.signal });
          } catch (error) {
            return {
              kind: 'error',
              error: classifyError(error),
              message: 'aborted',
              durationMs: 0,
            };
          }
        }
        return sendRequest(baseUrl, spec, {
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          socket,
        });
      }),
    );
  } finally {
    for (const socket of sockets) if (!(socket instanceof Error)) socket.destroy();
  }
}
