import { setTimeout as delay } from 'node:timers/promises';
import { analyzeRetryTiming, type RetryTimingAnalysis } from '../analysis/retry-timing.js';
import type { FaultConfig, RetryStormConfig } from '../config/types.js';
import { runLoad, summarizeOutcomes, type RequestOutcome } from '../http/request.js';
import type { ProxyAttempt } from '../runner/fault-proxy.js';
import { formatMs, formatRatio, plural } from '../shared/format.js';
import { round } from '../shared/time.js';
import { describeRequest } from './common.js';
import { verdict, type CheckDefinition, type Verdict } from './types.js';

export interface RetryStormMetrics {
  request: string;
  dependencyEnv: string;
  dependencyTarget: string;
  fault: FaultConfig;
  incomingRequests: number;
  downstreamAttempts: number;
  amplification: number;
  maxAmplification: number;
  attemptsDuringFault: number;
  attemptsForwarded: number;
  upstreamErrors: number;
  triggerResponses: string;
  timing: RetryTimingAnalysis;
}

function describeFault(fault: FaultConfig): string {
  return fault.type === 'status'
    ? `HTTP ${fault.status} for ${formatMs(fault.durationMs)}`
    : `connection resets for ${formatMs(fault.durationMs)}`;
}

export function toRetryStormMetrics(
  attempts: ProxyAttempt[],
  outcomes: RequestOutcome[],
  config: RetryStormConfig,
): RetryStormMetrics {
  const timing = analyzeRetryTiming({
    attemptsMs: attempts.map((attempt) => attempt.atMs),
    incomingRequests: config.trigger.requests,
    concurrency: config.trigger.concurrency,
  });
  const count = (result: ProxyAttempt['result']): number =>
    attempts.filter((attempt) => attempt.result === result).length;
  return {
    request: describeRequest(config.trigger.request),
    dependencyEnv: config.dependency.env,
    dependencyTarget: config.dependency.target,
    fault: config.fault,
    incomingRequests: config.trigger.requests,
    downstreamAttempts: attempts.length,
    amplification: round(timing.amplification, 2),
    maxAmplification: config.maxAmplification,
    attemptsDuringFault: count('fault'),
    attemptsForwarded: count('forwarded'),
    upstreamErrors: count('upstream-error'),
    triggerResponses: summarizeOutcomes(outcomes),
    timing,
  };
}

export function evaluateRetryStorm(metrics: RetryStormMetrics): Verdict<RetryStormMetrics> {
  const flow = `${plural(metrics.incomingRequests, 'request')} → ${plural(metrics.downstreamAttempts, 'downstream attempt')}`;

  if (metrics.downstreamAttempts === 0) {
    return verdict(
      'error',
      'no downstream calls reached the fault proxy',
      [
        `${metrics.request} did not call the dependency configured via ${metrics.dependencyEnv}.`,
        `Make sure that endpoint calls the dependency and that the service reads ${metrics.dependencyEnv} from its environment.`,
      ],
      metrics,
    );
  }

  const faultLine =
    `Fault: ${describeFault(metrics.fault)}. ${metrics.attemptsDuringFault} attempts received it, ` +
    `${metrics.attemptsForwarded} were forwarded to ${metrics.dependencyTarget}` +
    (metrics.upstreamErrors > 0 ? `, ${metrics.upstreamErrors} could not reach it.` : '.');
  const heuristics = metrics.timing.notes.map((note) => `Heuristic: ${note}`);

  if (metrics.amplification > metrics.maxAmplification) {
    return verdict(
      'fail',
      `${flow} (${formatRatio(metrics.amplification)})`,
      [
        `Retry amplification: ${formatRatio(metrics.amplification)} (limit ${formatRatio(metrics.maxAmplification)}).`,
        'Possible retry storm: a failing dependency receives several times the original traffic.',
        faultLine,
        ...heuristics,
      ],
      metrics,
    );
  }
  if (metrics.timing.jitter === 'absent') {
    return verdict(
      'warn',
      `${formatRatio(metrics.amplification)} amplification, but retries were synchronized`,
      [faultLine, ...heuristics],
      metrics,
    );
  }
  return verdict('pass', `${flow} (${formatRatio(metrics.amplification)})`, [], metrics);
}

export function retryStormCheck(config: RetryStormConfig): CheckDefinition {
  return {
    id: 'retry-storm',
    name: 'Retry behavior',
    async run(context) {
      const { proxy } = context;
      if (!proxy) return verdict('error', 'fault proxy is not running');

      proxy.beginWindow(config.fault);
      let attempts: ProxyAttempt[];
      let outcomes: RequestOutcome[];
      try {
        outcomes = await runLoad(context.baseUrl, config.trigger.request, {
          requests: config.trigger.requests,
          concurrency: config.trigger.concurrency,
          timeoutMs: config.trigger.timeoutMs,
          signal: context.signal,
        });
        // Background retries can outlive the incoming request.
        await delay(config.settleMs, undefined, { signal: context.signal });
      } finally {
        attempts = proxy.endWindow();
      }
      return evaluateRetryStorm(toRetryStormMetrics(attempts, outcomes, config));
    },
  };
}
