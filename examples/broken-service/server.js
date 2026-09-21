import { createServer } from 'node:http';
import { checkout } from './src/checkout.js';
import { exportUsers } from './src/export-users.js';
import { startFakePayments } from './src/fake-payments.js';
import { heavyReport } from './src/heavy-report.js';
import { createRouter, sendJson, sleep } from './src/http.js';
import { reserve, resetStockHandler } from './src/inventory.js';

const port = Number(process.env.PORT ?? 3100);
const paymentsPort = Number(process.env.PAYMENTS_PORT ?? 4100);
process.env.PAYMENTS_URL ??= `http://127.0.0.1:${paymentsPort}`;

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

startFakePayments(paymentsPort);
createServer(router).listen(port, '127.0.0.1', () => {
  console.log(`broken-service listening on http://127.0.0.1:${port}`);
});

// BUG: there is no SIGTERM handler. When an orchestrator stops this process
// (deploy, scale-down, node drain), Node.js' default action terminates it
// immediately and every in-flight request is cut off.
