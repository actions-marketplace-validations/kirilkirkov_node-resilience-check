import { readJson, sendJson, sleep } from './http.js';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 50;

async function charge(order) {
  // Read at call time so the URL can be pointed elsewhere per environment.
  const response = await fetch(`${process.env.PAYMENTS_URL}/charge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(order),
  });
  if (!response.ok) throw new Error(`payments responded with ${response.status}`);
  return response.json();
}

async function chargeWithRetry(order) {
  let lastError;
  // BUG: every failing request retries 5 times after the same fixed 50ms,
  // with no jitter and no retry budget. When the payments service has a
  // hiccup, all in-flight requests hammer it again in lockstep — each
  // incoming request turns into 6 downstream calls.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await charge(order);
    } catch (error) {
      lastError = error;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
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
