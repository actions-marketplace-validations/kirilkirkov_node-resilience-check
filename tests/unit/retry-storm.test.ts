import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeRetryTiming } from '../../src/analysis/retry-timing.js';
import { evaluateRetryStorm, type RetryStormMetrics } from '../../src/checks/retry-storm.js';
import { startFaultProxy, type FaultProxy } from '../../src/runner/fault-proxy.js';

function post(url: string): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const req = request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) =>
      resolve({ error: error.code ?? error.message }),
    );
    req.end('{"amount":1}');
  });
}

describe('fault proxy', () => {
  let upstream: Server;
  let upstreamHits: string[];
  let proxy: FaultProxy;

  beforeEach(async () => {
    upstreamHits = [];
    upstream = createServer((req, res) => {
      upstreamHits.push(req.url ?? '');
      req.resume();
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const port = (upstream.address() as AddressInfo).port;
    proxy = await startFaultProxy(`http://127.0.0.1:${port}/api`);
  });
  afterEach(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });

  it('binds to localhost only', () => {
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('forwards to the target, keeping its base path', async () => {
    const result = await post(`${proxy.url}/charge?id=1`);
    expect(result).toEqual({ status: 200, body: '{"ok":true,"path":"/api/charge?id=1"}' });
    expect(upstreamHits).toEqual(['/api/charge?id=1']);
  });

  it('injects the status fault during the window and records every attempt', async () => {
    proxy.beginWindow({ type: 'status', status: 503, durationMs: 60_000 });
    const results = await Promise.all([
      post(`${proxy.url}/charge?card=secret`),
      post(`${proxy.url}/charge`),
    ]);
    const attempts = proxy.endWindow();

    expect(results.map((result) => ('status' in result ? result.status : result.error))).toEqual([
      503, 503,
    ]);
    expect(upstreamHits).toEqual([]);
    expect(attempts).toHaveLength(2);
    // Query strings may carry user data and are not recorded.
    expect(attempts.map((attempt) => [attempt.method, attempt.path, attempt.result])).toEqual([
      ['POST', '/charge', 'fault'],
      ['POST', '/charge', 'fault'],
    ]);
    expect(attempts.every((attempt) => attempt.atMs >= 0)).toBe(true);
  });

  it('resets connections for the reset fault', async () => {
    proxy.beginWindow({ type: 'reset', durationMs: 60_000 });
    const result = await post(`${proxy.url}/charge`);
    proxy.endWindow();
    expect(result).toEqual({ error: 'ECONNRESET' });
  });

  it('forwards again once the fault duration has passed', async () => {
    proxy.beginWindow({ type: 'status', status: 503, durationMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await post(`${proxy.url}/charge`);
    const attempts = proxy.endWindow();
    expect(result).toMatchObject({ status: 200 });
    expect(attempts.map((attempt) => attempt.result)).toEqual(['forwarded']);
  });

  it('answers 502 when the target is unreachable', async () => {
    const orphan = await startFaultProxy('http://127.0.0.1:1');
    try {
      orphan.beginWindow({ type: 'status', status: 503, durationMs: 0 });
      const result = await post(`${orphan.url}/charge`);
      expect(result).toMatchObject({ status: 502 });
      expect(orphan.endWindow().map((attempt) => attempt.result)).toEqual(['upstream-error']);
    } finally {
      await orphan.close();
    }
  });
});

describe('evaluateRetryStorm', () => {
  function metrics(attemptsMs: number[], incoming = 20, max = 3): RetryStormMetrics {
    const timing = analyzeRetryTiming({
      attemptsMs,
      incomingRequests: incoming,
      concurrency: incoming,
    });
    return {
      request: 'POST /checkout',
      dependencyEnv: 'PAYMENTS_URL',
      dependencyTarget: 'http://127.0.0.1:4001',
      fault: { type: 'status', status: 503, durationMs: 3000 },
      incomingRequests: incoming,
      downstreamAttempts: attemptsMs.length,
      amplification: timing.amplification,
      maxAmplification: max,
      attemptsDuringFault: attemptsMs.length,
      attemptsForwarded: 0,
      upstreamErrors: 0,
      triggerResponses: '502×20',
      timing,
    };
  }
  const burst = (waves: number, size: number, gap: number): number[] =>
    Array.from({ length: waves * size }, (_, i) => Math.floor(i / size) * gap + (i % size) * 0.1);

  it('fails above the amplification limit and explains the heuristic', () => {
    const verdict = evaluateRetryStorm(metrics(burst(6, 20, 50)));
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toBe('20 requests → 120 downstream attempts (6.00x)');
    expect(verdict.details).toContain('Retry amplification: 6.00x (limit 3.00x).');
    expect(
      verdict.details.some((line) => line.startsWith('Heuristic:') && line.includes('jitter')),
    ).toBe(true);
  });

  it('warns about synchronized retries even when amplification is acceptable', () => {
    const verdict = evaluateRetryStorm(metrics(burst(2, 20, 50)));
    expect(verdict.status).toBe('warn');
    expect(verdict.summary).toBe('2.00x amplification, but retries were synchronized');
  });

  it('passes without retries', () => {
    expect(evaluateRetryStorm(metrics(burst(1, 20, 50))).status).toBe('pass');
  });

  it('errors when the dependency was never called', () => {
    const verdict = evaluateRetryStorm(metrics([]));
    expect(verdict.status).toBe('error');
    expect(verdict.details[1]).toMatch(/reads PAYMENTS_URL/);
  });
});
