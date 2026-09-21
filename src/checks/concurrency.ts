import type { ConcurrencyAssertion, ConcurrencyScenario } from '../config/types.js';
import { runLoad, isSuccess, summarizeOutcomes, type RequestOutcome } from '../http/request.js';
import { sendSimultaneously } from '../http/simultaneous.js';
import { createRandom, deriveSeed } from '../shared/random.js';
import { describeRequest } from './common.js';
import { verdict, type CheckDefinition, type Verdict } from './types.js';

export interface ConcurrencyRoundMetrics {
  round: number;
  successes: number;
  responses: string;
  /** Connection-level failures (no HTTP response at all). */
  errors: number;
}

export interface ConcurrencyMetrics {
  scenario: string;
  request: string;
  requests: number;
  successStatus: number[] | '2xx';
  maxSuccesses: number | null;
  minSuccesses: number | null;
  jitterMs: number;
  scenarioSeed: number;
  rounds: ConcurrencyRoundMetrics[];
}

export function isAssertedSuccess(
  outcome: RequestOutcome,
  assertion: ConcurrencyAssertion,
): boolean {
  if (outcome.kind !== 'response') return false;
  if (assertion.status === null) return outcome.status >= 200 && outcome.status < 300;
  return assertion.status.includes(outcome.status);
}

export function toRoundMetrics(
  round: number,
  outcomes: RequestOutcome[],
  assertion: ConcurrencyAssertion,
): ConcurrencyRoundMetrics {
  return {
    round,
    successes: outcomes.filter((outcome) => isAssertedSuccess(outcome, assertion)).length,
    responses: summarizeOutcomes(outcomes),
    errors: outcomes.filter((outcome) => outcome.kind === 'error').length,
  };
}

function violation(round: ConcurrencyRoundMetrics, metrics: ConcurrencyMetrics): string | null {
  if (metrics.maxSuccesses !== null && round.successes > metrics.maxSuccesses) {
    return `expected at most ${metrics.maxSuccesses} successful, got ${round.successes}`;
  }
  if (metrics.minSuccesses !== null && round.successes < metrics.minSuccesses) {
    return `expected at least ${metrics.minSuccesses} successful, got ${round.successes}`;
  }
  return null;
}

export function evaluateConcurrency(metrics: ConcurrencyMetrics): Verdict<ConcurrencyMetrics> {
  const statusLabel =
    metrics.successStatus === '2xx' ? 'any 2xx' : `status ${metrics.successStatus.join('/')}`;

  if (metrics.rounds.every((round) => round.errors === metrics.requests)) {
    return verdict(
      'error',
      'no HTTP responses received',
      [`Every request to ${metrics.request} failed at the connection level.`],
      metrics,
    );
  }

  for (const round of metrics.rounds) {
    const problem = violation(round, metrics);
    if (!problem) continue;
    const details = [
      `Concurrent requests: ${metrics.requests} × ${metrics.request}`,
      `Successful responses (${statusLabel}): ${round.successes}`,
    ];
    if (metrics.maxSuccesses !== null) details.push(`Maximum allowed: ${metrics.maxSuccesses}`);
    if (metrics.minSuccesses !== null) details.push(`Minimum required: ${metrics.minSuccesses}`);
    details.push(`Responses: ${round.responses}`);
    if (metrics.rounds.length > 1) {
      details.push(`Violated in round ${round.round} of ${metrics.rounds.length}.`);
    }
    details.push(
      'Possible concurrency/race-condition bug: the invariant did not hold under simultaneous requests.',
    );
    return verdict('fail', problem, details, metrics);
  }

  const last = metrics.rounds[metrics.rounds.length - 1];
  const summary =
    metrics.rounds.length > 1
      ? `invariant held in ${metrics.rounds.length} rounds`
      : `${last?.successes ?? 0}/${metrics.requests} successful (${statusLabel})`;
  return verdict('pass', summary, [], metrics);
}

export function concurrencyCheck(scenario: ConcurrencyScenario): CheckDefinition {
  return {
    id: 'concurrency',
    name: `Concurrency: ${scenario.name}`,
    async run(context) {
      const scenarioSeed = deriveSeed(context.seed, scenario.name);
      const random = createRandom(scenarioSeed);
      const rounds: ConcurrencyRoundMetrics[] = [];

      for (let round = 1; round <= scenario.rounds; round++) {
        if (scenario.setup) {
          const [setup] = await runLoad(context.baseUrl, scenario.setup, {
            requests: 1,
            concurrency: 1,
            timeoutMs: scenario.timeoutMs,
            signal: context.signal,
          });
          if (!setup || !isSuccess(setup)) {
            return verdict('error', `setup request ${describeRequest(scenario.setup)} failed`, [
              `Result: ${setup ? summarizeOutcomes([setup]) : 'not sent'}.`,
            ]);
          }
        }
        const delaysMs = Array.from({ length: scenario.requests }, () =>
          scenario.jitterMs > 0 ? random.int(0, scenario.jitterMs) : 0,
        );
        const outcomes = await sendSimultaneously(context.baseUrl, scenario.request, {
          delaysMs,
          timeoutMs: scenario.timeoutMs,
          signal: context.signal,
        });
        rounds.push(toRoundMetrics(round, outcomes, scenario.assert));
      }

      return evaluateConcurrency({
        scenario: scenario.name,
        request: describeRequest(scenario.request),
        requests: scenario.requests,
        successStatus: scenario.assert.status ?? '2xx',
        maxSuccesses: scenario.assert.maxSuccesses,
        minSuccesses: scenario.assert.minSuccesses,
        jitterMs: scenario.jitterMs,
        scenarioSeed,
        rounds,
      });
    },
  };
}
