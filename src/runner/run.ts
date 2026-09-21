import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  CheckContext,
  CheckDefinition,
  CheckId,
  CheckResult,
  Verdict,
} from '../checks/types.js';
import type { ResolvedConfig } from '../config/types.js';
import { round } from '../shared/time.js';
import { startFaultProxy, type FaultProxy } from './fault-proxy.js';
import { planChecks } from './plan.js';
import { buildReport, type FatalError, type RunReport } from './report.js';
import { startReporterServer } from './reporter-server.js';
import {
  buildServiceEnv,
  describeExit,
  ServiceStartError,
  startService,
  type ServiceProcess,
} from './service.js';

/** Resolved relative to this file so it works from both src/ and dist/. */
const AGENT_URL = new URL('../agent/index.js', import.meta.url).href;

export type RunEvent =
  | { type: 'service-starting' }
  | { type: 'service-ready'; pid: number | null; agent: boolean }
  | { type: 'check-start'; id: CheckId; name: string }
  | { type: 'check-result'; result: CheckResult };

export interface VerifyOptions {
  config: ResolvedConfig;
  seed: number;
  /** Restrict the run to these checks; null or undefined runs all enabled checks. */
  only?: readonly CheckId[] | null;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  onServiceOutput?: (line: string) => void;
  /** Receives the process right after spawn, e.g. to kill it from an exit hook. */
  onServiceSpawn?: (service: ServiceProcess) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCheck(check: CheckDefinition, context: CheckContext): Promise<CheckResult> {
  const started = performance.now();
  let outcome: Verdict<object>;
  try {
    outcome = await check.run(context);
  } catch (error) {
    outcome = context.signal.aborted
      ? { status: 'skip', summary: 'interrupted', details: [], metrics: null }
      : {
          status: 'error',
          summary: 'the check could not complete',
          details: [errorMessage(error)],
          metrics: null,
        };
  }
  return {
    id: check.id,
    name: check.name,
    status: outcome.status,
    summary: outcome.summary,
    details: outcome.details,
    metrics: outcome.metrics as Record<string, unknown> | null,
    durationMs: round(performance.now() - started),
  };
}

/** A crash during a check is itself a finding, so the check fails. */
function markCrashed(result: CheckResult, exitDescription: string, output: string[]): CheckResult {
  return {
    ...result,
    status: 'fail',
    summary: `service exited during the check (${exitDescription})`,
    details: [
      result.summary,
      ...result.details,
      'Last service output:',
      ...output.map((line) => `│ ${line}`),
    ],
  };
}

/**
 * Starts the service with the agent attached, runs every planned check in
 * order and always cleans up: service process group, fault proxy and the
 * reporter server.
 */
export async function runVerify(options: VerifyOptions): Promise<RunReport> {
  const { config, seed } = options;
  const signal = options.signal ?? new AbortController().signal;
  const startedAt = new Date();
  const started = performance.now();
  const token = randomBytes(24).toString('hex');
  const plan = planChecks(config.checks, options.only ?? null);
  const results: CheckResult[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  // Set from the spawn callback, so it is known even when startup fails.
  const spawned: { service: ServiceProcess | null } = { service: null };
  let fatalError: FatalError | null = null;

  try {
    const reporter = await startReporterServer(token);
    cleanups.push(() => reporter.close());

    const retryStorm = plan.some((check) => check.id === 'retry-storm')
      ? config.checks.retryStorm
      : null;
    let proxy: FaultProxy | null = null;
    if (retryStorm) {
      const faultProxy = await startFaultProxy(retryStorm.dependency.target);
      cleanups.push(() => faultProxy.close());
      proxy = faultProxy;
    }

    const env = buildServiceEnv(process.env, {
      config: config.service,
      agentUrl: AGENT_URL,
      reporterUrl: reporter.url,
      token,
      features: plan.some((check) => check.id === 'backpressure') ? ['backpressure'] : [],
      overrides: retryStorm && proxy ? { [retryStorm.dependency.env]: proxy.url } : {},
    });

    options.onEvent?.({ type: 'service-starting' });
    const running = await startService({
      config: config.service,
      env,
      token,
      reporter,
      signal,
      ...(options.onServiceOutput ? { onOutput: options.onServiceOutput } : {}),
      onSpawn: (service) => {
        spawned.service = service;
        options.onServiceSpawn?.(service);
      },
    });
    options.onEvent?.({
      type: 'service-ready',
      pid: running.targetPid ?? null,
      agent: running.agent !== null,
    });

    const context: CheckContext = {
      baseUrl: config.service.baseUrl,
      rootDir: config.service.cwd,
      service: running,
      proxy,
      seed,
      signal,
    };
    let crashed: string | null = null;
    for (const check of plan) {
      if (signal.aborted) break;
      if (crashed !== null) {
        const skipped: CheckResult = {
          id: check.id,
          name: check.name,
          status: 'skip',
          summary: 'service is no longer running',
          details: [`The service exited during an earlier check (${crashed}).`],
          metrics: null,
          durationMs: 0,
        };
        results.push(skipped);
        options.onEvent?.({ type: 'check-result', result: skipped });
        continue;
      }
      options.onEvent?.({ type: 'check-start', id: check.id, name: check.name });
      let result = await runCheck(check, context);
      if (signal.aborted) {
        // Aborted requests would otherwise read as a (misleading) verdict.
        result = { ...result, status: 'skip', summary: 'interrupted', details: [], metrics: null };
      } else if (!check.terminatesService && !running.isRunning()) {
        const exit = running.exitInfo();
        crashed = exit ? describeExit(exit) : 'the Node.js process is gone';
        result = markCrashed(result, crashed, running.recentOutput(8));
      }
      results.push(result);
      options.onEvent?.({ type: 'check-result', result });
    }
  } catch (error) {
    if (!signal.aborted) {
      fatalError = {
        message: errorMessage(error),
        serviceOutput: error instanceof ServiceStartError ? error.output : [],
      };
    }
  } finally {
    await spawned.service?.stop();
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  }

  const { service } = spawned;
  return buildReport({
    seed,
    startedAt,
    durationMs: performance.now() - started,
    command: config.service.command,
    baseUrl: config.service.baseUrl,
    pid: service?.targetPid ?? null,
    agent: (service?.agent ?? null) !== null,
    checks: results,
    fatalError,
    aborted: signal.aborted,
  });
}
