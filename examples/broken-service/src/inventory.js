import { readJson, sendJson, sleep } from './http.js';

// Product 1 has a single unit left. A real service would use a database;
// the sleeps simulate its round trips.
const stock = new Map();

export function resetStock() {
  stock.set('1', 1);
}
resetStock();

async function loadStock(productId) {
  await sleep(10);
  return stock.get(productId) ?? 0;
}

async function saveStock(productId, value) {
  await sleep(10);
  stock.set(productId, value);
}

export async function reserve(req, res, productId) {
  const { quantity = 1 } = await readJson(req);
  const available = await loadStock(productId);
  if (available < quantity) {
    sendJson(res, 409, { error: 'out of stock' });
    return;
  }
  // BUG: check-then-act across an await. Every concurrent request read the
  // same `available` above, so all of them "successfully" reserve the last
  // unit. Single-threaded JavaScript does not make this atomic.
  await saveStock(productId, available - quantity);
  sendJson(res, 200, { reserved: quantity });
}

/** Test-only endpoint so ResilienceCheck can repeat the scenario. */
export function resetStockHandler(req, res) {
  resetStock();
  sendJson(res, 200, { stock: 1 });
}
