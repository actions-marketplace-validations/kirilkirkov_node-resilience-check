import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { performance } from 'node:perf_hooks';
import type { FaultConfig } from '../config/types.js';

export type AttemptResult = 'fault' | 'forwarded' | 'upstream-error';

export interface ProxyAttempt {
  /** Milliseconds since the recording window began. */
  atMs: number;
  method: string;
  /** Path without the query string, which may carry user data. */
  path: string;
  result: AttemptResult;
}

export interface FaultProxy {
  readonly url: string;
  readonly target: string;
  /** Starts recording attempts and injects `fault` for its duration. */
  beginWindow(fault: FaultConfig): void;
  /** Stops recording and returns every attempt seen during the window. */
  endWindow(): ProxyAttempt[];
  close(): Promise<void>;
}

interface RecordingWindow {
  startedAt: number;
  faultUntil: number;
  fault: FaultConfig;
  attempts: ProxyAttempt[];
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) result[name] = value;
  }
  return result;
}

function injectFault(req: IncomingMessage, res: ServerResponse, fault: FaultConfig): void {
  if (fault.type === 'reset') {
    // RST instead of FIN, so the client sees ECONNRESET like a crashed peer.
    req.socket.resetAndDestroy();
    return;
  }
  req.resume();
  const body = JSON.stringify({ error: 'Fault injected by ResilienceCheck' });
  res.writeHead(fault.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * A deliberately small HTTP-only fault proxy, bound to 127.0.0.1. It sits
 * between the service and one downstream dependency, counts every attempt,
 * and returns the configured fault while a window is active. Outside the
 * fault period it forwards to the real target.
 */
export async function startFaultProxy(target: string): Promise<FaultProxy> {
  const targetUrl = new URL(target);
  const basePath = targetUrl.pathname.replace(/\/+$/, '');
  const upstreamAgent = new Agent({ keepAlive: true });
  let window: RecordingWindow | null = null;

  const forward = (req: IncomingMessage, res: ServerResponse, onError: () => void): void => {
    const upstream = httpRequest(
      {
        protocol: 'http:',
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        method: req.method ?? 'GET',
        path: basePath + (req.url ?? '/'),
        headers: { ...endToEndHeaders(req.headers), host: targetUrl.host },
        agent: upstreamAgent,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, endToEndHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      onError();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = JSON.stringify({
        error: `ResilienceCheck proxy could not reach ${target}: ${error.message}`,
      });
      res.writeHead(502, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    });
    req.pipe(upstream);
  };

  const server = createServer((req, res) => {
    const now = performance.now();
    const active = window;
    let attempt: ProxyAttempt | null = null;
    if (active) {
      attempt = {
        atMs: now - active.startedAt,
        method: req.method ?? 'GET',
        path: (req.url ?? '/').split('?')[0] ?? '/',
        result: 'forwarded',
      };
      active.attempts.push(attempt);
      if (now < active.faultUntil) {
        attempt.result = 'fault';
        injectFault(req, res, active.fault);
        return;
      }
    }
    forward(req, res, () => {
      if (attempt) attempt.result = 'upstream-error';
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fault proxy has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    target,
    beginWindow(fault) {
      const startedAt = performance.now();
      window = { startedAt, faultUntil: startedAt + fault.durationMs, fault, attempts: [] };
    },
    endWindow() {
      const attempts = window?.attempts ?? [];
      window = null;
      return attempts;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        upstreamAgent.destroy();
      });
    },
  };
}
