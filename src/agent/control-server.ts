import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentStatus, BackpressureReport, EventLoopSnapshot } from '../shared/protocol.js';

export interface ControlHandlers {
  status(): AgentStatus;
  startEventLoop(resolutionMs: number): void;
  stopEventLoop(): EventLoopSnapshot;
  backpressure(): BackpressureReport;
  resetBackpressure(): void;
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Localhost-only HTTP endpoint the CLI uses to drive measurements inside the
 * service process. Every handle is unref'd so the agent can never keep the
 * service alive or delay its shutdown.
 */
export function startControlServer(token: string, handlers: ControlHandlers): Promise<Server> {
  const server = createServer((req, res) => {
    void handle(req, res, token, handlers);
  });
  server.on('connection', (socket) => socket.unref());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve(server);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  handlers: ControlHandlers,
): Promise<void> {
  try {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(res, 401, { error: 'unauthorized' });
    }
    const body = await readJson(req);
    const route = `${req.method ?? 'GET'} ${req.url ?? '/'}`;
    switch (route) {
      case 'GET /v1/status':
        return send(res, 200, handlers.status());
      case 'POST /v1/event-loop/start': {
        const resolution = Number((body as { resolutionMs?: unknown } | null)?.resolutionMs ?? 10);
        handlers.startEventLoop(Number.isFinite(resolution) && resolution >= 1 ? resolution : 10);
        return send(res, 200, { ok: true });
      }
      case 'POST /v1/event-loop/stop':
        return send(res, 200, handlers.stopEventLoop());
      case 'GET /v1/backpressure':
        return send(res, 200, handlers.backpressure());
      case 'POST /v1/backpressure/reset':
        handlers.resetBackpressure();
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: 'not found' });
    }
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  res.end(body);
}
