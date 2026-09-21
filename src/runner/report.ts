import type { CheckResult } from '../checks/types.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

/** Bump when the JSON report changes in a way consumers must handle. */
export const REPORT_SCHEMA_VERSION = 1;

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  errors: number;
}

export interface FatalError {
  message: string;
  /** Last lines of service output, when the service was involved. */
  serviceOutput: string[];
}

export interface RunReport {
  schemaVersion: number;
  tool: { name: string; version: string };
  /** Same as tool.version; kept at the top level for quick inspection. */
  version: string;
  seed: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: { node: string; platform: NodeJS.Platform; arch: string };
  service: {
    command: string;
    baseUrl: string;
    pid: number | null;
    agent: boolean;
  };
  summary: ReportSummary;
  /** 0 = all checks passed, 1 = at least one check failed or errored, 2 = could not run. */
  exitCode: 0 | 1 | 2;
  aborted: boolean;
  fatalError: FatalError | null;
  checks: CheckResult[];
}

export function summarize(checks: CheckResult[]): ReportSummary {
  const count = (status: CheckResult['status']): number =>
    checks.filter((check) => check.status === status).length;
  return {
    total: checks.length,
    passed: count('pass'),
    failed: count('fail'),
    warnings: count('warn'),
    skipped: count('skip'),
    errors: count('error'),
  };
}

export function exitCodeFor(summary: ReportSummary, fatal: boolean, aborted: boolean): 0 | 1 | 2 {
  if (fatal || aborted) return 2;
  return summary.failed > 0 || summary.errors > 0 ? 1 : 0;
}

export interface ReportInput {
  seed: number;
  startedAt: Date;
  durationMs: number;
  command: string;
  baseUrl: string;
  pid: number | null;
  agent: boolean;
  checks: CheckResult[];
  fatalError: FatalError | null;
  aborted: boolean;
}

export function buildReport(input: ReportInput): RunReport {
  const summary = summarize(input.checks);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: PACKAGE_NAME, version: VERSION },
    version: VERSION,
    seed: input.seed,
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date(input.startedAt.getTime() + input.durationMs).toISOString(),
    durationMs: Math.round(input.durationMs),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    service: {
      command: input.command,
      baseUrl: input.baseUrl,
      pid: input.pid,
      agent: input.agent,
    },
    summary,
    exitCode: exitCodeFor(summary, input.fatalError !== null, input.aborted),
    aborted: input.aborted,
    fatalError: input.fatalError,
    checks: input.checks,
  };
}
