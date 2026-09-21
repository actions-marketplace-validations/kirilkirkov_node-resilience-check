import type { FaultProxy } from '../runner/fault-proxy.js';
import type { ServiceProcess } from '../runner/service.js';

export type CheckId =
  'event-loop' | 'backpressure' | 'retry-storm' | 'concurrency' | 'graceful-shutdown';

/**
 * - pass: the measured behaviour stayed within the configured limits
 * - fail: a limit was exceeded
 * - warn: nothing exceeded a limit, but the result deserves attention or the
 *         scenario could not exercise the behaviour (does not fail CI)
 * - skip: the check did not run (platform, earlier crash, …)
 * - error: the check could not produce a trustworthy result (fails CI)
 */
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'error';

/** What a check's evaluator decides, before timing/identity are attached. */
export interface Verdict<M> {
  status: CheckStatus;
  /** One short line shown next to the check name. */
  summary: string;
  /** Additional lines shown indented under the check. */
  details: string[];
  metrics: M | null;
}

export interface CheckResult<M = Record<string, unknown>> extends Verdict<M> {
  id: CheckId;
  /** Display name, e.g. "Concurrency: reserve-stock". */
  name: string;
  durationMs: number;
}

export interface CheckContext {
  baseUrl: string;
  /** Directory used to shorten file paths in output (the service's cwd). */
  rootDir: string;
  service: ServiceProcess;
  proxy: FaultProxy | null;
  seed: number;
  signal: AbortSignal;
}

export interface CheckDefinition {
  id: CheckId;
  name: string;
  /** True for checks that intentionally terminate the service. */
  terminatesService?: boolean;
  run(context: CheckContext): Promise<Verdict<object>>;
}

export function verdict<M>(
  status: CheckStatus,
  summary: string,
  details: string[] = [],
  metrics: M | null = null,
): Verdict<M> {
  return { status, summary, details, metrics };
}
