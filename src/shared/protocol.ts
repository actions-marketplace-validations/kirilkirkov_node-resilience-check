/**
 * Contract between the CLI and the preload agent that runs inside the target
 * service. Both sides import this module, so it must stay dependency-free.
 */
import type { StackFrame } from './stack.js';

/** Base URL of the CLI's localhost reporter server. */
export const ENV_REPORTER = 'RESILIENCE_CHECK_REPORTER';
/** Shared secret; the agent and CLI reject requests without it. */
export const ENV_TOKEN = 'RESILIENCE_CHECK_TOKEN';
/** Comma-separated optional agent features, e.g. `backpressure`. */
export const ENV_FEATURES = 'RESILIENCE_CHECK_FEATURES';

/**
 * Sent with every health-check request. The agent stays inert until it sees
 * this header, which is how the CLI identifies the process that actually
 * serves HTTP when the command is wrapped by npm, a shell, etc.
 */
export const PROBE_HEADER = 'x-resilience-check-probe';

export type AgentFeature = 'backpressure';

export interface AgentRegistration {
  token: string;
  pid: number;
  ppid: number;
  controlUrl: string;
  nodeVersion: string;
  features: AgentFeature[];
}

export interface AgentStatus {
  pid: number;
  activeRequests: number;
  signalListeners: { SIGTERM: number; SIGINT: number };
}

/** Raw histogram values in nanoseconds, exactly as Node reports them. */
export interface EventLoopSnapshot {
  samples: number;
  minNs: number;
  maxNs: number;
  meanNs: number;
  stddevNs: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
  /** Event loop utilization (0..1) over the measurement window. */
  utilization: number;
  windowMs: number;
}

export interface BackpressureSite {
  /** `application` when the first non-internal frame is outside node_modules. */
  attribution: 'application' | 'dependency';
  location: StackFrame | null;
  frames: StackFrame[];
  streamType: string;
  ignoredWrites: number;
  episodes: number;
}

export interface BackpressureReport {
  installed: boolean;
  /** How often any tracked write() returned false. */
  backpressureSignals: number;
  /** write() calls from user or dependency code while waiting for 'drain'. */
  ignoredWrites: number;
  /** Same, but made by Node.js internals (not reported as violations). */
  ignoredInternalWrites: number;
  episodes: number;
  sites: BackpressureSite[];
  /** Ignored writes not attributed to a site because the site limit was hit. */
  overflowWrites: number;
}
