import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AgentRegistration } from '../shared/protocol.js';

export interface ReporterServer {
  readonly url: string;
  /** Resolves with the first registration, or null after `timeoutMs`. */
  waitForAgent(timeoutMs: number): Promise<AgentRegistration | null>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isRegistration(value: unknown, token: string): value is AgentRegistration {
  const candidate = value as Partial<AgentRegistration> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.token === 'string' &&
    safeEqual(candidate.token, token) &&
    Number.isInteger(candidate.pid) &&
    typeof candidate.controlUrl === 'string' &&
    candidate.controlUrl.startsWith('http://127.0.0.1:') &&
    Array.isArray(candidate.features)
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The CLI side of the local channel. It binds to 127.0.0.1 only and accepts a
 * single kind of message: an agent announcing its control URL.
 */
export async function startReporterServer(token: string): Promise<ReporterServer> {
  let registration: AgentRegistration | null = null;
  const waiters = new Set<(registration: AgentRegistration) => void>();

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/agents') {
      res.writeHead(404).end();
      return;
    }
    readBody(req)
      .then((text) => {
        const payload: unknown = JSON.parse(text);
        if (!isRegistration(payload, token)) {
          res.writeHead(403).end();
          return;
        }
        if (registration === null) {
          registration = payload;
          for (const notify of waiters) notify(payload);
          waiters.clear();
        }
        res.writeHead(204).end();
      })
      .catch(() => res.writeHead(400).end());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Reporter server has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    waitForAgent(timeoutMs) {
      if (registration) return Promise.resolve(registration);
      return new Promise((resolve) => {
        const notify = (value: AgentRegistration): void => {
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          waiters.delete(notify);
          resolve(null);
        }, timeoutMs);
        waiters.add(notify);
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
