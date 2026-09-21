export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RequestBody {
  contentType: string;
  data: string;
}

export interface RequestSpec {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  body: RequestBody | null;
}

export interface ServiceConfig {
  command: string;
  /** Absolute working directory for the command. */
  cwd: string;
  /** Normalised, without a trailing slash. */
  baseUrl: string;
  healthPath: string;
  startupTimeoutMs: number;
  env: Record<string, string>;
}

export interface EventLoopConfig {
  enabled: boolean;
  request: RequestSpec;
  requests: number;
  concurrency: number;
  maxP99Ms: number;
  resolutionMs: number;
  timeoutMs: number;
}

export interface BackpressureConfig {
  enabled: boolean;
  request: RequestSpec;
  requests: number;
  /** How long the slow client stops reading before it drains the response. */
  holdMs: number;
  maxIgnoredWrites: number;
  timeoutMs: number;
}

export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface GracefulShutdownConfig {
  enabled: boolean;
  request: RequestSpec;
  concurrency: number;
  signal: ShutdownSignal;
  signalAfterMs: number;
  shutdownTimeoutMs: number;
  maxDroppedRequests: number;
}

export type FaultConfig =
  { type: 'status'; status: number; durationMs: number } | { type: 'reset'; durationMs: number };

export interface RetryStormConfig {
  enabled: boolean;
  dependency: { env: string; target: string };
  trigger: { request: RequestSpec; requests: number; concurrency: number; timeoutMs: number };
  fault: FaultConfig;
  maxAmplification: number;
  settleMs: number;
}

export interface ConcurrencyAssertion {
  /** Statuses that count as a "success"; null means any 2xx. */
  status: number[] | null;
  maxSuccesses: number | null;
  minSuccesses: number | null;
}

export interface ConcurrencyScenario {
  name: string;
  request: RequestSpec;
  requests: number;
  rounds: number;
  jitterMs: number;
  setup: RequestSpec | null;
  assert: ConcurrencyAssertion;
  timeoutMs: number;
}

export interface ChecksConfig {
  eventLoop: EventLoopConfig | null;
  backpressure: BackpressureConfig | null;
  gracefulShutdown: GracefulShutdownConfig | null;
  retryStorm: RetryStormConfig | null;
  concurrency: ConcurrencyScenario[];
}

export interface ResolvedConfig {
  /** Absolute path of the file the config was loaded from. */
  configPath: string;
  /** Directory of the config file; relative paths resolve against it. */
  rootDir: string;
  service: ServiceConfig;
  checks: ChecksConfig;
}
