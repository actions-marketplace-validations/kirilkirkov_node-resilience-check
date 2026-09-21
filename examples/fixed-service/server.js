import { createServer } from 'node:http';
import { checkout } from './src/checkout.js';
import { exportUsers } from './src/export-users.js';
import { startFakePayments } from './src/fake-payments.js';
import { heavyReport } from './src/heavy-report.js';
import { createRouter, sendJson, sleep } from './src/http.js';
import { reserve, resetStockHandler } from './src/inventory.js';

const port = Number(process.env.PORT ?? 3200);
const paymentsPort = Number(process.env.PAYMENTS_PORT ?? 4200);
process.env.PAYMENTS_URL ??= `http://127.0.0.1:${paymentsPort}`;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const router = createRouter({
  'GET /health': (req, res) => sendJson(res, 200, { status: 'ok' }),
  'GET /heavy-report': heavyReport,
  'GET /export/users': exportUsers,
  'POST /checkout': checkout,
  'POST /products/:id/reserve': reserve,
  'POST /test/reset-stock': resetStockHandler,
  'GET /slow': async (req, res) => {
    await sleep(800);
    sendJson(res, 200, { status: 'done' });
  },
});

const payments = startFakePayments(paymentsPort);
const server = createServer(router).listen(port, '127.0.0.1', () => {
  console.log(`fixed-service listening on http://127.0.0.1:${port}`);
});

// FIX: on SIGTERM stop accepting new connections, let in-flight requests
// finish, then exit. A hard deadline guarantees the process never hangs past
// the orchestrator's grace period.
function shutdown(signal) {
  console.log(`${signal} received, finishing in-flight requests…`);
  setTimeout(() => {
    console.error('Shutdown deadline reached, exiting.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  payments.close();
  server.close((error) => process.exit(error ? 1 : 0));
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
