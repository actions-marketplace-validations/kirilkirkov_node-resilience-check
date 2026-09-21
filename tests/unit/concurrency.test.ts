import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateConcurrency,
  isAssertedSuccess,
  toRoundMetrics,
  type ConcurrencyMetrics,
} from '../../src/checks/concurrency.js';
import type { RequestOutcome } from '../../src/http/request.js';
import { sendSimultaneously } from '../../src/http/simultaneous.js';

const response = (status: number): RequestOutcome => ({ kind: 'response', status, durationMs: 1 });
const reset: RequestOutcome = {
  kind: 'error',
  error: 'reset',
  message: 'socket hang up',
  durationMs: 1,
};

function metrics(overrides: Partial<ConcurrencyMetrics> = {}): ConcurrencyMetrics {
  return {
    scenario: 'reserve-stock',
    request: 'POST /products/1/reserve',
    requests: 10,
    successStatus: [200],
    maxSuccesses: 1,
    minSuccesses: null,
    jitterMs: 0,
    scenarioSeed: 1,
    rounds: [{ round: 1, successes: 1, responses: '409×9, 200×1', errors: 0 }],
    ...overrides,
  };
}

describe('isAssertedSuccess', () => {
  it('treats any 2xx as success when no status is configured', () => {
    const assertion = { status: null, maxSuccesses: 1, minSuccesses: null };
    expect(isAssertedSuccess(response(201), assertion)).toBe(true);
    expect(isAssertedSuccess(response(302), assertion)).toBe(false);
    expect(isAssertedSuccess(reset, assertion)).toBe(false);
  });

  it('uses the configured status list otherwise', () => {
    const assertion = { status: [200, 202], maxSuccesses: 1, minSuccesses: null };
    expect(isAssertedSuccess(response(202), assertion)).toBe(true);
    expect(isAssertedSuccess(response(201), assertion)).toBe(false);
  });
});

describe('toRoundMetrics', () => {
  it('counts successes, responses and connection errors', () => {
    const outcomes = [response(200), response(200), response(409), reset];
    expect(
      toRoundMetrics(2, outcomes, { status: [200], maxSuccesses: 1, minSuccesses: null }),
    ).toEqual({
      round: 2,
      successes: 2,
      responses: '200×2, 409×1, reset×1',
      errors: 1,
    });
  });
});

describe('evaluateConcurrency', () => {
  it('passes when the invariant holds', () => {
    const verdict = evaluateConcurrency(metrics());
    expect(verdict.status).toBe('pass');
    expect(verdict.summary).toBe('1/10 successful (status 200)');
  });

  it('fails with the observed numbers when too many requests succeed', () => {
    const verdict = evaluateConcurrency(
      metrics({ rounds: [{ round: 1, successes: 2, responses: '409×8, 200×2', errors: 0 }] }),
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toBe('expected at most 1 successful, got 2');
    expect(verdict.details).toEqual([
      'Concurrent requests: 10 × POST /products/1/reserve',
      'Successful responses (status 200): 2',
      'Maximum allowed: 1',
      'Responses: 409×8, 200×2',
      'Possible concurrency/race-condition bug: the invariant did not hold under simultaneous requests.',
    ]);
  });

  it('checks minimum successes and names the failing round', () => {
    const verdict = evaluateConcurrency(
      metrics({
        maxSuccesses: null,
        minSuccesses: 10,
        successStatus: '2xx',
        rounds: [
          { round: 1, successes: 10, responses: '200×10', errors: 0 },
          { round: 2, successes: 7, responses: '200×7, 500×3', errors: 0 },
        ],
      }),
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toBe('expected at least 10 successful, got 7');
    expect(verdict.details).toContain('Violated in round 2 of 2.');
  });

  it('errors when no request got an HTTP response', () => {
    const verdict = evaluateConcurrency(
      metrics({ rounds: [{ round: 1, successes: 0, responses: 'refused×10', errors: 10 }] }),
    );
    expect(verdict.status).toBe('error');
  });
});

describe('sendSimultaneously', () => {
  let server: Server;
  let baseUrl: string;
  let stock: number;
  let arrivals: number[];

  beforeEach(async () => {
    stock = 1;
    arrivals = [];
    // A classic check-then-act race across an await.
    server = createServer((req, res) => {
      arrivals.push(performance.now());
      req.resume();
      const available = stock;
      setTimeout(() => {
        if (available < 1) {
          res.writeHead(409).end();
          return;
        }
        stock = available - 1;
        res.writeHead(200).end();
      }, 20);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  const request = {
    method: 'POST' as const,
    path: '/reserve',
    headers: {},
    body: { contentType: 'application/json', data: '{}' },
  };

  it('makes the requests arrive together and exposes the race', async () => {
    const outcomes = await sendSimultaneously(baseUrl, request, {
      delaysMs: new Array(10).fill(0),
      timeoutMs: 5000,
    });
    expect(
      outcomes.filter((outcome) => outcome.kind === 'response' && outcome.status === 200),
    ).toHaveLength(10);
    const spread = Math.max(...arrivals) - Math.min(...arrivals);
    expect(spread).toBeLessThan(20);
  });

  it('applies per-request delays', async () => {
    const outcomes = await sendSimultaneously(baseUrl, request, {
      delaysMs: [0, 60],
      timeoutMs: 5000,
    });
    expect(outcomes.map((outcome) => (outcome.kind === 'response' ? outcome.status : 0))).toEqual([
      200, 409,
    ]);
  });

  it('reports refused connections as outcomes instead of throwing', async () => {
    server.close();
    await once(server, 'close');
    const outcomes = await sendSimultaneously(baseUrl, request, {
      delaysMs: [0, 0],
      timeoutMs: 1000,
    });
    expect(
      outcomes.every((outcome) => outcome.kind === 'error' && outcome.error === 'refused'),
    ).toBe(true);
  });
});
