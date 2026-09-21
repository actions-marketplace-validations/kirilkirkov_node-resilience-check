import { readJson, sendJson, sleep } from './http.js';

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;

async function charge(order) {
  const response = await fetch(`${process.env.PAYMENTS_URL}/charge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(order),
  });
  if (!response.ok) throw new Error(`payments responded with ${response.status}`);
  return response.json();
}

async function chargeWithRetry(order) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await charge(order);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      // FIX: few attempts, exponential backoff and "full jitter". Retries from
      // many concurrent requests are spread out instead of arriving in
      // synchronized waves, and the dependency sees at most 3x the traffic.
      // Production code would also only retry idempotent operations (or use
      // an idempotency key) and add a circuit breaker.
      await sleep(Math.random() * BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

export async function checkout(req, res) {
  const { amount = 42 } = await readJson(req);
  try {
    const payment = await chargeWithRetry({ amount });
    sendJson(res, 200, { status: 'paid', payment });
  } catch {
    sendJson(res, 502, { error: 'payment failed' });
  }
}
