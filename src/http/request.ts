import { Agent, request as httpRequest, type ClientRequest, type RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { RequestSpec } from '../config/types.js';

export type RequestErrorKind = 'refused' | 'reset' | 'timeout' | 'aborted' | 'failed';

export type RequestOutcome =
  | { kind: 'response'; status: number; durationMs: number }
  | { kind: 'error'; error: RequestErrorKind; message: string; durationMs: number };

export interface SendOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  agent?: Agent | false;
  headers?: Record<string, string>;
  /** Use an already-connected socket instead of opening a new one. */
  socket?: Socket;
}

const USER_AGENT = 'node-resilience-check';

export function buildUrl(baseUrl: string, path: string): URL {
  return new URL(baseUrl + path);
}

export function buildHeaders(
  spec: RequestSpec,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...spec.headers, ...extra };
  if (spec.body) {
    headers['content-type'] ??= spec.body.contentType;
    headers['content-length'] = String(Buffer.byteLength(spec.body.data));
  }
  return headers;
}

export function classifyError(error: unknown): RequestErrorKind {
  const err = error as NodeJS.ErrnoException;
  if (err?.name === 'AbortError') return 'aborted';
  switch (err?.code) {
    case 'ECONNREFUSED':
      return 'refused';
    case 'ECONNRESET':
    case 'EPIPE':
    case 'ERR_STREAM_PREMATURE_CLOSE':
      return 'reset';
    default:
      return 'failed';
  }
}

class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`no complete response within ${timeoutMs}ms`);
  }
}

/**
 * Sends one request and fully consumes the response body. Never rejects:
 * every failure is returned as an outcome so load generators can count them.
 */
export function sendRequest(
  baseUrl: string,
  spec: RequestSpec,
  options: SendOptions,
): Promise<RequestOutcome> {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;

  return new Promise((resolve) => {
    let settled = false;
    let req: ClientRequest | undefined;
    const timer = setTimeout(
      () => req?.destroy(new RequestTimeoutError(options.timeoutMs)),
      options.timeoutMs,
    );

    const finish = (outcome: RequestOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const fail = (error: unknown): void => {
      finish({
        kind: 'error',
        error: error instanceof RequestTimeoutError ? 'timeout' : classifyError(error),
        message: error instanceof Error ? error.message : String(error),
        durationMs: elapsed(),
      });
    };

    const requestOptions: RequestOptions = {
      method: spec.method,
      headers: buildHeaders(spec, options.headers),
      signal: options.signal,
    };
    const { socket } = options;
    if (socket) {
      requestOptions.createConnection = () => socket;
    } else {
      requestOptions.agent = options.agent ?? false;
    }

    try {
      req = httpRequest(buildUrl(baseUrl, spec.path), requestOptions, (res) => {
        res.on('error', fail);
        res.on('end', () =>
          finish({ kind: 'response', status: res.statusCode ?? 0, durationMs: elapsed() }),
        );
        // 'close' before 'end' means the connection died mid-body.
        res.on('close', () => {
          if (!res.complete)
            fail(Object.assign(new Error('response ended prematurely'), { code: 'ECONNRESET' }));
        });
        res.resume();
      });
    } catch (error) {
      fail(error);
      return;
    }
    req.on('error', fail);
    req.end(spec.body?.data);
  });
}

export interface LoadOptions {
  requests: number;
  concurrency: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  headers?: Record<string, string>;
}

/** Sends `requests` requests with at most `concurrency` in flight. */
export async function runLoad(
  baseUrl: string,
  spec: RequestSpec,
  options: LoadOptions,
): Promise<RequestOutcome[]> {
  const workers = Math.min(options.concurrency, options.requests);
  const agent = new Agent({ keepAlive: true, maxSockets: workers });
  const outcomes: RequestOutcome[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < options.requests && !options.signal?.aborted) {
      next++;
      outcomes.push(
        await sendRequest(baseUrl, spec, {
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          agent,
          ...(options.headers ? { headers: options.headers } : {}),
        }),
      );
    }
  };

  try {
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    agent.destroy();
  }
  return outcomes;
}

export function isSuccess(outcome: RequestOutcome): boolean {
  return outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 400;
}

/** Short human summary such as "404×20" or "503×3, reset×2". */
export function summarizeOutcomes(outcomes: RequestOutcome[]): string {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    const key = outcome.kind === 'response' ? String(outcome.status) : outcome.error;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}×${count}`)
    .join(', ');
}
