import { describe, expect, it } from 'vitest';
import { createEventLoopProbe } from '../../src/agent/event-loop.js';
import {
  evaluateEventLoop,
  nsToMs,
  toEventLoopMetrics,
  type EventLoopMetrics,
} from '../../src/checks/event-loop.js';
import type { EventLoopConfig } from '../../src/config/types.js';
import type { RequestOutcome } from '../../src/http/request.js';

const config: EventLoopConfig = {
  enabled: true,
  request: { method: 'GET', path: '/heavy-report', headers: {}, body: null },
  requests: 3,
  concurrency: 2,
  maxP99Ms: 100,
  resolutionMs: 10,
  timeoutMs: 1000,
};

const ok: RequestOutcome = { kind: 'response', status: 200, durationMs: 5 };

function metrics(overrides: Partial<EventLoopMetrics> = {}): EventLoopMetrics {
  return {
    request: 'GET /heavy-report',
    requests: 20,
    concurrency: 5,
    succeededRequests: 20,
    failedRequests: 0,
    responses: '200×20',
    samples: 100,
    minMs: 10,
    meanMs: 12,
    p50Ms: 11,
    p95Ms: 15,
    p99Ms: 18,
    maxMs: 20,
    stddevMs: 1,
    utilization: 0.1,
    maxP99Ms: 100,
    ...overrides,
  };
}

describe('nsToMs', () => {
  it('converts the nanoseconds reported by monitorEventLoopDelay', () => {
    expect(nsToMs(1_000_000)).toBe(1);
    expect(nsToMs(284_000_000)).toBe(284);
    expect(nsToMs(10_551_295)).toBeCloseTo(10.551295);
  });
});

describe('toEventLoopMetrics', () => {
  it('converts every percentile to milliseconds and counts failures', () => {
    const result = toEventLoopMetrics(
      {
        samples: 42,
        minNs: 10_027_008,
        maxNs: 431_226_879,
        meanNs: 30_500_000,
        stddevNs: 5_000_000,
        p50Ns: 11_001_856,
        p95Ns: 120_455_167,
        p99Ns: 284_164_095,
        utilization: 0.87654,
        windowMs: 1500,
      },
      [ok, ok, { kind: 'response', status: 500, durationMs: 1 }],
      config,
    );
    expect(result).toMatchObject({
      samples: 42,
      minMs: 10.03,
      meanMs: 30.5,
      p50Ms: 11,
      p95Ms: 120.46,
      p99Ms: 284.16,
      maxMs: 431.23,
      utilization: 0.877,
      requests: 3,
      succeededRequests: 2,
      failedRequests: 1,
      responses: '200×2, 500×1',
    });
  });
});

describe('evaluateEventLoop', () => {
  it('passes when p99 stays under the limit', () => {
    const verdict = evaluateEventLoop(metrics());
    expect(verdict.status).toBe('pass');
    expect(verdict.summary).toBe('p99 18ms');
  });

  it('passes at exactly the limit and fails just above it', () => {
    expect(evaluateEventLoop(metrics({ p99Ms: 100 })).status).toBe('pass');
    expect(evaluateEventLoop(metrics({ p99Ms: 100.01 })).status).toBe('fail');
  });

  it('reports the distribution when the event loop was blocked', () => {
    const verdict = evaluateEventLoop(
      metrics({ p50Ms: 120, p95Ms: 250, p99Ms: 284, maxMs: 431, utilization: 0.934 }),
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toBe('p99 284ms (limit 100ms)');
    expect(verdict.details).toContain(
      'p50 120ms · p95 250ms · p99 284ms · max 431ms (100 samples)',
    );
    expect(verdict.details).toContain(
      'Maximum observed delay: 431ms. The event loop was busy 93% of the time; synchronous work is blocking every other request.',
    );
  });

  it('refuses to pass when every scenario request failed', () => {
    const verdict = evaluateEventLoop(
      metrics({ succeededRequests: 0, failedRequests: 20, responses: '404×20' }),
    );
    expect(verdict.status).toBe('error');
    expect(verdict.details[0]).toBe('Responses: 404×20.');
  });

  it('warns when no samples were collected', () => {
    expect(evaluateEventLoop(metrics({ samples: 0 })).status).toBe('warn');
  });
});

describe('event loop probe', () => {
  it('measures a real synchronous block', async () => {
    const probe = createEventLoopProbe();
    probe.start(10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const until = Date.now() + 120;
    while (Date.now() < until) {
      // block the event loop
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    const snapshot = probe.stop();
    expect(snapshot.samples).toBeGreaterThan(0);
    expect(nsToMs(snapshot.maxNs)).toBeGreaterThan(100);
    expect(snapshot.utilization).toBeGreaterThan(0);
  });

  it('refuses to stop before starting', () => {
    expect(() => createEventLoopProbe().stop()).toThrow(/not started/);
  });
});
