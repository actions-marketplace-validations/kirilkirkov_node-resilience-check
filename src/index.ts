/**
 * Programmatic API. The CLI is the primary interface; this entry point exists
 * for custom runners and CI integrations and may change before 1.0.
 */
export { runVerify, type RunEvent, type VerifyOptions } from './runner/run.js';
export {
  REPORT_SCHEMA_VERSION,
  type FatalError,
  type ReportSummary,
  type RunReport,
} from './runner/report.js';
export { CHECK_IDS } from './runner/plan.js';
export { loadConfig, DEFAULT_CONFIG_FILE, ConfigNotFoundError } from './config/load.js';
export { validateConfig, ConfigError } from './config/validate.js';
export type * from './config/types.js';
export type { CheckId, CheckResult, CheckStatus } from './checks/types.js';
export type { EventLoopMetrics } from './checks/event-loop.js';
export type { BackpressureMetrics } from './checks/backpressure.js';
export type { RetryStormMetrics } from './checks/retry-storm.js';
export type { ConcurrencyMetrics } from './checks/concurrency.js';
export type { GracefulShutdownMetrics } from './checks/graceful-shutdown.js';
export { analyzeRetryTiming, type RetryTimingAnalysis } from './analysis/retry-timing.js';
export { generateSeed } from './shared/random.js';
export { VERSION } from './version.js';
