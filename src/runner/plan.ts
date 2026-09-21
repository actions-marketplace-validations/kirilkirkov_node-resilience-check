import { backpressureCheck } from '../checks/backpressure.js';
import { concurrencyCheck } from '../checks/concurrency.js';
import { eventLoopCheck } from '../checks/event-loop.js';
import { gracefulShutdownCheck } from '../checks/graceful-shutdown.js';
import { retryStormCheck } from '../checks/retry-storm.js';
import type { CheckDefinition, CheckId } from '../checks/types.js';
import type { ChecksConfig } from '../config/types.js';

export const CHECK_IDS: readonly CheckId[] = [
  'event-loop',
  'backpressure',
  'retry-storm',
  'concurrency',
  'graceful-shutdown',
];

/**
 * Builds the ordered list of checks to run. Graceful shutdown terminates the
 * service, so it always runs last.
 */
export function planChecks(
  checks: ChecksConfig,
  only: readonly CheckId[] | null,
): CheckDefinition[] {
  const wanted = (id: CheckId): boolean => only === null || only.includes(id);
  const plan: CheckDefinition[] = [];
  if (checks.eventLoop && wanted('event-loop')) plan.push(eventLoopCheck(checks.eventLoop));
  if (checks.backpressure && wanted('backpressure'))
    plan.push(backpressureCheck(checks.backpressure));
  if (checks.retryStorm && wanted('retry-storm')) plan.push(retryStormCheck(checks.retryStorm));
  if (wanted('concurrency')) plan.push(...checks.concurrency.map(concurrencyCheck));
  if (checks.gracefulShutdown && wanted('graceful-shutdown')) {
    plan.push(gracefulShutdownCheck(checks.gracefulShutdown));
  }
  return plan;
}
