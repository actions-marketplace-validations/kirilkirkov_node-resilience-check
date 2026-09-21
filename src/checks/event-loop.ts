import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { EventLoopConfig } from '../config/types.js';
import { isSuccess, runLoad, summarizeOutcomes, type RequestOutcome } from '../http/request.js';
import { formatMs, plural } from '../shared/format.js';
import type { EventLoopSnapshot } from '../shared/protocol.js';
import { round } from '../shared/time.js';
import { agentMissing, describeRequest } from './common.js';
import { verdict, type CheckDefinition, type Verdict } from './types.js';

/**
 * The histogram samples once per resolution period, so a scenario that ends
 * within a few milliseconds would yield no data. The measurement window is
 * therefore at least this many periods long.
 */
const MIN_SAMPLE_PERIODS = 10;

export interface EventLoopMetrics {
  request: string;
  requests: number;
  concurrency: number;
  succeededRequests: number;
  failedRequests: number;
  responses: string;
  samples: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  stddevMs: number;
  /** Event loop utilization (0..1) while the scenario ran. */
  utilization: number;
  maxP99Ms: number;
}

/** monitorEventLoopDelay() reports nanoseconds. */
export function nsToMs(nanoseconds: number): number {
  return nanoseconds / 1e6;
}

export function toEventLoopMetrics(
  snapshot: EventLoopSnapshot,
  outcomes: RequestOutcome[],
  config: EventLoopConfig,
): EventLoopMetrics {
  const succeeded = outcomes.filter(isSuccess).length;
  const ms = (ns: number): number => round(nsToMs(ns), 2);
  return {
    request: describeRequest(config.request),
    requests: outcomes.length,
    concurrency: config.concurrency,
    succeededRequests: succeeded,
    failedRequests: outcomes.length - succeeded,
    responses: summarizeOutcomes(outcomes),
    samples: snapshot.samples,
    minMs: ms(snapshot.minNs),
    meanMs: ms(snapshot.meanNs),
    p50Ms: ms(snapshot.p50Ns),
    p95Ms: ms(snapshot.p95Ns),
    p99Ms: ms(snapshot.p99Ns),
    maxMs: ms(snapshot.maxNs),
    stddevMs: ms(snapshot.stddevNs),
    utilization: round(snapshot.utilization, 3),
    maxP99Ms: config.maxP99Ms,
  };
}

export function evaluateEventLoop(metrics: EventLoopMetrics): Verdict<EventLoopMetrics> {
  const distribution =
    `p50 ${formatMs(metrics.p50Ms)} · p95 ${formatMs(metrics.p95Ms)} · ` +
    `p99 ${formatMs(metrics.p99Ms)} · max ${formatMs(metrics.maxMs)}`;
  const failures =
    metrics.failedRequests > 0
      ? [
          `${metrics.failedRequests} of ${metrics.requests} requests did not succeed (${metrics.responses}).`,
        ]
      : [];

  if (metrics.requests > 0 && metrics.succeededRequests === 0) {
    return verdict(
      'error',
      `every request to ${metrics.request} failed`,
      [
        `Responses: ${metrics.responses}.`,
        'The event loop was not measured under realistic load; check eventLoop.path.',
      ],
      metrics,
    );
  }
  if (metrics.samples === 0) {
    return verdict(
      'warn',
      'no event-loop samples collected',
      ['The scenario finished before the histogram took a sample; increase eventLoop.requests.'],
      metrics,
    );
  }
  if (metrics.p99Ms > metrics.maxP99Ms) {
    return verdict(
      'fail',
      `p99 ${formatMs(metrics.p99Ms)} (limit ${formatMs(metrics.maxP99Ms)})`,
      [
        `Event-loop delay while serving ${metrics.request} (${metrics.requests} requests, concurrency ${metrics.concurrency}):`,
        `${distribution} (${plural(metrics.samples, 'sample')})`,
        `Maximum observed delay: ${formatMs(metrics.maxMs)}. The event loop was busy ` +
          `${Math.round(metrics.utilization * 100)}% of the time; synchronous work is blocking every other request.`,
        ...failures,
      ],
      metrics,
    );
  }
  return verdict('pass', `p99 ${formatMs(metrics.p99Ms)}`, failures, metrics);
}

export function eventLoopCheck(config: EventLoopConfig): CheckDefinition {
  return {
    id: 'event-loop',
    name: 'Event loop',
    async run(context) {
      const { agent } = context.service;
      if (!agent) return agentMissing();

      const started = performance.now();
      await agent.startEventLoop(config.resolutionMs);
      // runLoad never rejects (failures are outcomes). If the wait below is
      // interrupted, the service is being stopped and the histogram with it.
      const outcomes = await runLoad(context.baseUrl, config.request, {
        requests: config.requests,
        concurrency: config.concurrency,
        timeoutMs: config.timeoutMs,
        signal: context.signal,
      });
      const remainingMs = config.resolutionMs * MIN_SAMPLE_PERIODS - (performance.now() - started);
      if (remainingMs > 0) await delay(remainingMs, undefined, { signal: context.signal });
      const snapshot = await agent.stopEventLoop();
      return evaluateEventLoop(toEventLoopMetrics(snapshot, outcomes, config));
    },
  };
}
