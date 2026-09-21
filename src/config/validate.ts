import { dirname, resolve } from 'node:path';
import { joinPath, ObjectReader } from './reader.js';
import {
  HTTP_METHODS,
  SHUTDOWN_SIGNALS,
  type BackpressureConfig,
  type ChecksConfig,
  type ConcurrencyScenario,
  type EventLoopConfig,
  type FaultConfig,
  type GracefulShutdownConfig,
  type RequestBody,
  type RequestSpec,
  type ResolvedConfig,
  type RetryStormConfig,
  type ServiceConfig,
} from './types.js';

export class ConfigError extends Error {
  constructor(
    readonly issues: string[],
    readonly file: string | null = null,
  ) {
    super(`Invalid configuration:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates raw JSON and resolves defaults. Throws a ConfigError listing every
 * problem as a plain sentence.
 */
export function validateConfig(input: unknown, configPath: string): ResolvedConfig {
  const issues: string[] = [];
  const rootDir = dirname(configPath);
  const root = ObjectReader.from(input, '', issues);
  if (!root) throw new ConfigError(issues, configPath);

  root.raw('$schema');
  const serviceReader = root.object('service', { required: true });
  const service = serviceReader ? readService(serviceReader, rootDir) : null;
  const checksReader = root.object('checks', { required: false });
  const checks = readChecks(checksReader, issues);
  root.finish();

  if (issues.length > 0 || service === null) throw new ConfigError(issues, configPath);

  const enabledCount =
    Number(checks.eventLoop !== null) +
    Number(checks.backpressure !== null) +
    Number(checks.gracefulShutdown !== null) +
    Number(checks.retryStorm !== null) +
    checks.concurrency.length;
  if (enabledCount === 0) {
    throw new ConfigError(['checks must enable at least one check.'], configPath);
  }

  return { configPath, rootDir, service, checks };
}

function readService(reader: ObjectReader, rootDir: string): ServiceConfig {
  const command = reader.requiredString('command');
  const cwd = reader.optionalString('cwd');
  const baseUrl = readHttpUrl(reader, 'baseUrl');
  const healthPath = readPath(reader, 'healthPath', '/health');
  const startupTimeoutMs = reader.number('startupTimeoutMs', { default: 10_000, greaterThan: 0 });
  const env = reader.stringRecord('env');
  reader.finish();
  return {
    command,
    cwd: resolve(rootDir, cwd ?? '.'),
    baseUrl,
    healthPath,
    startupTimeoutMs,
    env,
  };
}

function readHttpUrl(reader: ObjectReader, key: string): string {
  const raw = reader.requiredString(key);
  if (raw === '') return '';
  let url: URL;
  try {
    // "localhost:3000" parses as a URL with scheme "localhost:", so require "://".
    if (!raw.includes('://')) throw new Error('missing scheme');
    url = new URL(raw);
  } catch {
    reader.issue(key, `must be a valid URL such as "http://127.0.0.1:3000" (got "${raw}").`);
    return '';
  }
  if (url.protocol !== 'http:') {
    reader.issue(
      key,
      `must use http:// (got "${url.protocol}//"). HTTPS targets are not supported yet.`,
    );
    return '';
  }
  if (url.search !== '' || url.hash !== '') {
    reader.issue(key, 'must not contain a query string or fragment.');
    return '';
  }
  return url.href.replace(/\/+$/, '');
}

function readPath(reader: ObjectReader, key: string, fallback?: string): string {
  const value = fallback === undefined ? reader.requiredString(key) : reader.optionalString(key);
  if (value === null) return fallback ?? '';
  if (value !== '' && !value.startsWith('/')) {
    reader.issue(key, `must start with "/" (got "${value}").`);
  }
  return value;
}

function lowerCaseKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

/** Reads `method`, `path`, `headers` and `body` from the given object. */
function readRequestFields(
  reader: ObjectReader,
  defaultMethod: RequestSpec['method'],
): RequestSpec {
  const method = reader.oneOf('method', HTTP_METHODS, defaultMethod, (value) =>
    value.toUpperCase(),
  );
  const path = readPath(reader, 'path');
  const headers = lowerCaseKeys(reader.stringRecord('headers'));
  const rawBody = reader.raw('body');
  let body: RequestBody | null = null;
  if (rawBody !== undefined) {
    body =
      typeof rawBody === 'string'
        ? { contentType: headers['content-type'] ?? 'text/plain; charset=utf-8', data: rawBody }
        : {
            contentType: headers['content-type'] ?? 'application/json',
            data: JSON.stringify(rawBody),
          };
  }
  return { method, path, headers, body };
}

function readRequestObject(
  reader: ObjectReader,
  key: string,
  required: boolean,
): RequestSpec | null {
  const child = reader.object(key, { required });
  if (!child) return null;
  const request = readRequestFields(child, 'GET');
  child.finish();
  return request;
}

/** A check is disabled when its section is missing or `enabled` is false. */
function openCheck(checks: ObjectReader | null, key: string): ObjectReader | null {
  if (!checks) return null;
  const section = checks.object(key, { required: false });
  if (!section) return null;
  if (!section.boolean('enabled', true)) {
    // Disabled sections may hold incomplete placeholders; skip validation.
    return null;
  }
  return section;
}

function readChecks(reader: ObjectReader | null, issues: string[]): ChecksConfig {
  const eventLoop = readEventLoop(openCheck(reader, 'eventLoop'));
  const backpressure = readBackpressure(openCheck(reader, 'backpressure'));
  const gracefulShutdown = readGracefulShutdown(openCheck(reader, 'gracefulShutdown'));
  const retryStorm = readRetryStorm(openCheck(reader, 'retryStorm'));
  const concurrency = reader ? readConcurrency(reader, issues) : [];
  reader?.finish();
  return { eventLoop, backpressure, gracefulShutdown, retryStorm, concurrency };
}

function readEventLoop(reader: ObjectReader | null): EventLoopConfig | null {
  if (!reader) return null;
  const config: EventLoopConfig = {
    enabled: true,
    request: readRequestFields(reader, 'GET'),
    requests: reader.number('requests', { default: 20, integer: true, min: 1 }),
    concurrency: reader.number('concurrency', { default: 5, integer: true, min: 1 }),
    maxP99Ms: reader.number('maxP99Ms', { default: 100, greaterThan: 0 }),
    resolutionMs: reader.number('resolutionMs', { default: 10, integer: true, min: 1 }),
    timeoutMs: reader.number('timeoutMs', { default: 10_000, greaterThan: 0 }),
  };
  reader.finish();
  return config;
}

function readBackpressure(reader: ObjectReader | null): BackpressureConfig | null {
  if (!reader) return null;
  const config: BackpressureConfig = {
    enabled: true,
    request: readRequestFields(reader, 'GET'),
    requests: reader.number('requests', { default: 1, integer: true, min: 1, max: 50 }),
    holdMs: reader.number('holdMs', { default: 1000, integer: true, min: 0 }),
    maxIgnoredWrites: reader.number('maxIgnoredWrites', { default: 0, integer: true, min: 0 }),
    timeoutMs: reader.number('timeoutMs', { default: 30_000, greaterThan: 0 }),
  };
  reader.finish();
  return config;
}

function readGracefulShutdown(reader: ObjectReader | null): GracefulShutdownConfig | null {
  if (!reader) return null;
  const config: GracefulShutdownConfig = {
    enabled: true,
    request: readRequestFields(reader, 'GET'),
    concurrency: reader.number('concurrency', { default: 10, integer: true, min: 1 }),
    signal: reader.oneOf('signal', SHUTDOWN_SIGNALS, 'SIGTERM', (value) => value.toUpperCase()),
    signalAfterMs: reader.number('signalAfterMs', { default: 100, integer: true, min: 0 }),
    shutdownTimeoutMs: reader.number('shutdownTimeoutMs', { default: 5000, greaterThan: 0 }),
    maxDroppedRequests: reader.number('maxDroppedRequests', { default: 0, integer: true, min: 0 }),
  };
  reader.finish();
  return config;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readRetryStorm(reader: ObjectReader | null): RetryStormConfig | null {
  if (!reader) return null;

  const dependencyReader = reader.object('dependency', { required: true });
  let dependency = { env: '', target: '' };
  if (dependencyReader) {
    const env = dependencyReader.requiredString('env');
    if (env !== '' && !ENV_NAME.test(env)) {
      dependencyReader.issue('env', `must be a valid environment variable name (got "${env}").`);
    }
    dependency = { env, target: readHttpUrl(dependencyReader, 'target') };
    dependencyReader.finish();
  }

  const triggerReader = reader.object('trigger', { required: true });
  let trigger: RetryStormConfig['trigger'] = {
    request: { method: 'GET', path: '/', headers: {}, body: null },
    requests: 20,
    concurrency: 20,
    timeoutMs: 30_000,
  };
  if (triggerReader) {
    const request = readRequestFields(triggerReader, 'GET');
    const requests = triggerReader.number('requests', { default: 20, integer: true, min: 1 });
    trigger = {
      request,
      requests,
      concurrency: triggerReader.number('concurrency', {
        default: requests,
        integer: true,
        min: 1,
      }),
      timeoutMs: triggerReader.number('timeoutMs', { default: 30_000, greaterThan: 0 }),
    };
    triggerReader.finish();
  }

  const config: RetryStormConfig = {
    enabled: true,
    dependency,
    trigger,
    fault: readFault(reader.object('fault', { required: false })),
    maxAmplification: reader.number('maxAmplification', { default: 3, min: 1 }),
    settleMs: reader.number('settleMs', { default: 500, integer: true, min: 0 }),
  };
  reader.finish();
  return config;
}

function readFault(reader: ObjectReader | null): FaultConfig {
  if (!reader) return { type: 'status', status: 503, durationMs: 3000 };
  const type = reader.oneOf('type', ['status', 'reset'] as const, 'status');
  const durationMs = reader.number('durationMs', { default: 3000, integer: true, min: 1 });
  let fault: FaultConfig;
  if (type === 'status') {
    const status = reader.number('status', { default: 503, integer: true, min: 400, max: 599 });
    fault = { type, status, durationMs };
  } else {
    if (reader.has('status')) {
      reader.raw('status');
      reader.issue('status', 'is only used when fault.type is "status".');
    }
    fault = { type, durationMs };
  }
  reader.finish();
  return fault;
}

function readConcurrency(checks: ObjectReader, issues: string[]): ConcurrencyScenario[] {
  const raw = checks.raw('concurrency');
  if (raw === undefined) return [];
  const path = checks.pathOf('concurrency');
  if (!Array.isArray(raw)) {
    issues.push(`${path} must be an array of scenarios.`);
    return [];
  }
  const names = new Set<string>();
  const scenarios: ConcurrencyScenario[] = [];
  raw.forEach((entry: unknown, index) => {
    const reader = ObjectReader.from(entry, joinPath(path, index), issues);
    if (!reader) return;
    if (!reader.boolean('enabled', true)) return;
    const scenario = readScenario(reader);
    if (scenario.name !== '') {
      if (names.has(scenario.name)) {
        reader.issue('name', `"${scenario.name}" is used by more than one scenario.`);
      }
      names.add(scenario.name);
    }
    scenarios.push(scenario);
  });
  return scenarios;
}

function readScenario(reader: ObjectReader): ConcurrencyScenario {
  const name = reader.requiredString('name');
  const request = readRequestObject(reader, 'request', true) ?? {
    method: 'GET',
    path: '/',
    headers: {},
    body: null,
  };
  const requests = reader.number('requests', { default: 10, integer: true, min: 2, max: 1000 });
  const rounds = reader.number('rounds', { default: 1, integer: true, min: 1, max: 100 });
  const jitterMs = reader.number('jitterMs', { default: 0, integer: true, min: 0 });
  const setup = readRequestObject(reader, 'setup', false);
  const timeoutMs = reader.number('timeoutMs', { default: 10_000, greaterThan: 0 });

  const assertReader = reader.object('assert', { required: true });
  let assertion: ConcurrencyScenario['assert'] = {
    status: null,
    maxSuccesses: null,
    minSuccesses: null,
  };
  if (assertReader) {
    assertion = {
      status: readStatusList(assertReader),
      maxSuccesses: assertReader.optionalNumber('maxSuccesses', { integer: true, min: 0 }),
      minSuccesses: assertReader.optionalNumber('minSuccesses', { integer: true, min: 0 }),
    };
    if (assertion.maxSuccesses === null && assertion.minSuccesses === null) {
      reader.issue('assert', 'must set maxSuccesses and/or minSuccesses.');
    }
    if (
      assertion.maxSuccesses !== null &&
      assertion.minSuccesses !== null &&
      assertion.minSuccesses > assertion.maxSuccesses
    ) {
      assertReader.issue('minSuccesses', 'must not be greater than maxSuccesses.');
    }
    if (assertion.maxSuccesses !== null && assertion.maxSuccesses > requests) {
      assertReader.issue('maxSuccesses', `must not be greater than requests (${requests}).`);
    }
    assertReader.finish();
  }
  reader.finish();
  return { name, request, requests, rounds, jitterMs, setup, assert: assertion, timeoutMs };
}

function readStatusList(reader: ObjectReader): number[] | null {
  const raw = reader.raw('status');
  if (raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const valid = list.every(
    (status) =>
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599,
  );
  if (!valid || list.length === 0) {
    reader.issue('status', 'must be an HTTP status code or a list of status codes.');
    return null;
  }
  return list as number[];
}
