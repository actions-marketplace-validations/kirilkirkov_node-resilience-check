import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { GracefulShutdownConfig } from '../config/types.js';
import { sendRequest, summarizeOutcomes, type RequestOutcome } from '../http/request.js';
import type { AgentClient } from '../runner/agent-client.js';
import { formatMs } from '../shared/format.js';
import { round } from '../shared/time.js';
import { describeRequest } from './common.js';
import { verdict, type CheckDefinition, type Verdict } from './types.js';

const IN_FLIGHT_WAIT_MS = 3000;

export interface GracefulShutdownMetrics {
  request: string;
  signal: GracefulShutdownConfig['signal'];
  targetPid: number | null;
  sent: number;
  inFlightAtSignal: number;
  /** Full response with a status below 500. */
  completed: number;
  /** Full response with a 5xx status. */
  failedResponses: number;
  /** No complete response: connection reset, closed or timed out. */
  dropped: number;
  responses: string;
  exitedAfterMs: number | null;
  timedOut: boolean;
  shutdownTimeoutMs: number;
  maxDroppedRequests: number;
  /** Signal listeners registered by the app, when the agent could tell. */
  signalHandlers: number | null;
}

export interface ShutdownMeasurement {
  outcomes: RequestOutcome[];
  inFlightAtSignal: number;
  exitedAfterMs: number | null;
  signalHandlers: number | null;
  targetPid: number | null;
}

export function toGracefulShutdownMetrics(
  measurement: ShutdownMeasurement,
  config: GracefulShutdownConfig,
): GracefulShutdownMetrics {
  const { outcomes } = measurement;
  const responses = outcomes.filter((outcome) => outcome.kind === 'response');
  return {
    request: describeRequest(config.request),
    signal: config.signal,
    targetPid: measurement.targetPid,
    sent: outcomes.length,
    inFlightAtSignal: measurement.inFlightAtSignal,
    completed: responses.filter((outcome) => outcome.status < 500).length,
    failedResponses: responses.filter((outcome) => outcome.status >= 500).length,
    dropped: outcomes.length - responses.length,
    responses: summarizeOutcomes(outcomes),
    exitedAfterMs: measurement.exitedAfterMs === null ? null : round(measurement.exitedAfterMs),
    timedOut: measurement.exitedAfterMs === null,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    maxDroppedRequests: config.maxDroppedRequests,
    signalHandlers: measurement.signalHandlers,
  };
}

export function evaluateGracefulShutdown(
  metrics: GracefulShutdownMetrics,
): Verdict<GracefulShutdownMetrics> {
  const lost = metrics.dropped + metrics.failedResponses;
  const counts = [
    `Requests in flight at ${metrics.signal}: ${metrics.inFlightAtSignal} (of ${metrics.sent} sent)`,
    `Completed: ${metrics.completed}`,
    `Dropped (no complete response): ${metrics.dropped}`,
  ];
  if (metrics.failedResponses > 0) counts.push(`Failed with 5xx: ${metrics.failedResponses}`);
  const exitLine =
    metrics.exitedAfterMs === null
      ? `Process was still running ${formatMs(metrics.shutdownTimeoutMs)} after ${metrics.signal}.`
      : `Process exited ${formatMs(metrics.exitedAfterMs)} after ${metrics.signal}.`;
  const noHandler =
    metrics.signalHandlers === 0
      ? [
          `No ${metrics.signal} listener was registered, so Node.js used the default action and terminated immediately.`,
        ]
      : [];

  if (metrics.timedOut) {
    return verdict(
      'fail',
      `did not exit within ${formatMs(metrics.shutdownTimeoutMs)} of ${metrics.signal}`,
      [
        ...counts,
        exitLine,
        'Orchestrators such as Kubernetes send SIGKILL after their grace period, which drops all remaining work.',
        'Common causes: open keep-alive connections, timers, or database pools that are never closed.',
      ],
      metrics,
    );
  }

  if (lost > metrics.maxDroppedRequests) {
    return verdict(
      'fail',
      `${lost} of ${metrics.inFlightAtSignal} in-flight requests lost`,
      [
        ...counts,
        exitLine,
        ...noHandler,
        'A lost request did not receive a complete, non-5xx response. Clients may retry idempotent requests, but in-flight work was cut off.',
      ],
      metrics,
    );
  }

  if (metrics.inFlightAtSignal === 0) {
    return verdict(
      'warn',
      `no requests were in flight at ${metrics.signal}`,
      [
        `Every request to ${metrics.request} finished before the signal, so shutdown behaviour under load was not exercised.`,
        'Use a slower endpoint or lower signalAfterMs.',
        exitLine,
        ...noHandler,
      ],
      metrics,
    );
  }

  return verdict(
    'pass',
    `${metrics.completed}/${metrics.sent} requests completed, exited after ${formatMs(metrics.exitedAfterMs ?? 0)}`,
    [],
    metrics,
  );
}

/** Polls the agent until the requests actually reached the server. */
async function waitForInFlight(
  agent: AgentClient | null,
  expected: number,
  signal: AbortSignal,
): Promise<void> {
  if (!agent) return;
  const deadline = performance.now() + IN_FLIGHT_WAIT_MS;
  while (performance.now() < deadline && !signal.aborted) {
    const status = await agent.status().catch(() => null);
    if (!status || status.activeRequests >= expected) return;
    await delay(10);
  }
}

export function gracefulShutdownCheck(config: GracefulShutdownConfig): CheckDefinition {
  return {
    id: 'graceful-shutdown',
    name: 'Graceful shutdown',
    terminatesService: true,
    async run(context) {
      if (process.platform === 'win32') {
        return verdict('skip', 'not supported on Windows', [
          'Windows has no POSIX signals; Node.js cannot deliver SIGTERM to a process there.',
        ]);
      }
      const { service } = context;
      const { agent } = service;
      const status = agent ? await agent.status().catch(() => null) : null;

      let settled = 0;
      const pending = Array.from({ length: config.concurrency }, () =>
        sendRequest(context.baseUrl, config.request, {
          timeoutMs: config.signalAfterMs + config.shutdownTimeoutMs + 5000,
          signal: context.signal,
          agent: false,
        }).then((outcome) => {
          settled++;
          return outcome;
        }),
      );

      await waitForInFlight(agent, config.concurrency, context.signal);
      await delay(config.signalAfterMs, undefined, { signal: context.signal });

      const inFlightAtSignal = config.concurrency - settled;
      const signalledAt = performance.now();
      service.signalTarget(config.signal);
      const exited = await service.waitForTargetExit(config.shutdownTimeoutMs);
      const exitedAfterMs = exited ? performance.now() - signalledAt : null;
      if (!exited) await service.stop();

      const outcomes = await Promise.all(pending);
      return evaluateGracefulShutdown(
        toGracefulShutdownMetrics(
          {
            outcomes,
            inFlightAtSignal,
            exitedAfterMs,
            signalHandlers: status ? status.signalListeners[config.signal] : null,
            targetPid: service.targetPid ?? null,
          },
          config,
        ),
      );
    },
  };
}
