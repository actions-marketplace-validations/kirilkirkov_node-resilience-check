import { createServer } from 'node:http';
import { readJson, sendJson } from './http.js';

/**
 * A stand-in for a real downstream dependency. It runs inside the same
 * process only so the demo starts with a single command; the service still
 * talks to it over HTTP through PAYMENTS_URL.
 */
export function startFakePayments(port) {
  let nextId = 1;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/charge') {
      const { amount } = await readJson(req);
      sendJson(res, 200, { id: `pay_${nextId++}`, amount });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
  server.listen(port, '127.0.0.1');
  return server;
}
