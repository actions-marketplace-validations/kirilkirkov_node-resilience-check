import { readJson, sendJson, sleep } from './http.js';

const stock = new Map();

export function resetStock() {
  stock.set('1', 1);
}
resetStock();

/**
 * FIX: the check and the decrement happen in one step with no await in
 * between, so no other request can interleave. In a real database this is a
 * single conditional statement, e.g.
 *   UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1
 * and checking the affected row count.
 */
async function reserveStock(productId, quantity) {
  await sleep(10); // simulated round trip
  const available = stock.get(productId) ?? 0;
  if (available < quantity) return false;
  stock.set(productId, available - quantity);
  return true;
}

export async function reserve(req, res, productId) {
  const { quantity = 1 } = await readJson(req);
  if (await reserveStock(productId, quantity)) {
    sendJson(res, 200, { reserved: quantity });
  } else {
    sendJson(res, 409, { error: 'out of stock' });
  }
}

/** Test-only endpoint so ResilienceCheck can repeat the scenario. */
export function resetStockHandler(req, res) {
  resetStock();
  sendJson(res, 200, { stock: 1 });
}
