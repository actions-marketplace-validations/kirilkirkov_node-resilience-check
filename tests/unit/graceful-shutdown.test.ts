import { describe, expect, it } from 'vitest';
import {
  evaluateGracefulShutdown,
  toGracefulShutdownMetrics,
} from '../../src/checks/graceful-shutdown.js';
import type { GracefulShutdownConfig } from '../../src/config/types.js';
import type { RequestOutcome } from '../../src/http/request.js';

const config: GracefulShutdownConfig = {
  enabled: true,
  request: { method: 'GET', path: '/slow', headers: {}, body: null },
  concurrency: 20,
  signal: 'SIGTERM',
  signalAfterMs: 100,
  shutdownTimeoutMs: 5000,
  maxDroppedRequests: 0,
};

const done: RequestOutcome = { kind: 'response', status: 200, durationMs: 800 };
const dropped: RequestOutcome = {
  kind: 'error',
  error: 'reset',
  message: 'socket hang up',
  durationMs: 110,
};
const unavailable: RequestOutcome = { kind: 'response', status: 503, durationMs: 120 };

function evaluate(
  outcomes: RequestOutcome[],
  overrides: {
    inFlightAtSignal?: number;
    exitedAfterMs?: number | null;
    signalHandlers?: number | null;
  } = {},
) {
  return evaluateGracefulShutdown(
    toGracefulShutdownMetrics(
      {
        outcomes,
        inFlightAtSignal: overrides.inFlightAtSignal ?? outcomes.length,
        exitedAfterMs: overrides.exitedAfterMs === undefined ? 482.4 : overrides.exitedAfterMs,
        signalHandlers: overrides.signalHandlers === undefined ? 1 : overrides.signalHandlers,
        targetPid: 1234,
      },
      config,
    ),
  );
}

describe('toGracefulShutdownMetrics', () => {
  it('separates completed, failed and dropped requests', () => {
    const metrics = toGracefulShutdownMetrics(
      {
        outcomes: [done, done, unavailable, dropped],
        inFlightAtSignal: 4,
        exitedAfterMs: 12.6,
        signalHandlers: 0,
        targetPid: 1,
      },
      config,
    );
    expect(metrics).toMatchObject({
      sent: 4,
      completed: 2,
      failedResponses: 1,
      dropped: 1,
      exitedAfterMs: 13,
      timedOut: false,
      responses: '200×2, 503×1, reset×1',
    });
  });
});

describe('evaluateGracefulShutdown', () => {
  it('passes when every in-flight request completes', () => {
    const verdict = evaluate(new Array(20).fill(done));
    expect(verdict.status).toBe('pass');
    expect(verdict.summary).toBe('20/20 requests completed, exited after 482ms');
  });

  it('fails when requests are dropped and explains a missing handler', () => {
    const verdict = evaluate([...new Array(13).fill(done), ...new Array(7).fill(dropped)], {
      signalHandlers: 0,
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toBe('7 of 20 in-flight requests lost');
    expect(verdict.details).toEqual(
      expect.arrayContaining([
        'Requests in flight at SIGTERM: 20 (of 20 sent)',
        'Completed: 13',
        'Dropped (no complete response): 7',
        'Process exited 482ms after SIGTERM.',
        'No SIGTERM listener was registered, so Node.js used the default action and terminated immediately.',
      ]),
    );
  });

  it('counts 5xx responses as lost requests', () => {
    const verdict = evaluate([done, unavailable]);
    expect(verdict.status).toBe('fail');
    expect(verdict.details).toContain('Failed with 5xx: 1');
  });

  it('respects maxDroppedRequests', () => {
    const verdict = evaluateGracefulShutdown(
      toGracefulShutdownMetrics(
        {
          outcomes: [done, dropped],
          inFlightAtSignal: 2,
          exitedAfterMs: 5,
          signalHandlers: 1,
          targetPid: 1,
        },
        { ...config, maxDroppedRequests: 1 },
      ),
    );
    expect(verdict.status).toBe('pass');
  });

  it('fails when the process outlives the shutdown timeout', () => {
    const verdict = evaluate(new Array(3).fill(done), { exitedAfterMs: null });
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toBe('did not exit within 5.0s of SIGTERM');
  });

  it('warns when nothing was in flight at the signal', () => {
    const verdict = evaluate(new Array(3).fill(done), { inFlightAtSignal: 0, signalHandlers: 0 });
    expect(verdict.status).toBe('warn');
    expect(verdict.summary).toBe('no requests were in flight at SIGTERM');
    // A missing handler is still worth knowing about.
    expect(verdict.details.some((line) => line.startsWith('No SIGTERM listener'))).toBe(true);
  });
});
