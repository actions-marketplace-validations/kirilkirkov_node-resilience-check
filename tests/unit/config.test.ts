import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigNotFoundError, loadConfig } from '../../src/config/load.js';
import { createConfigTemplate } from '../../src/config/template.js';
import { ConfigError, validateConfig } from '../../src/config/validate.js';

const CONFIG_PATH = '/project/resiliencecheck.config.json';

const service = { command: 'node server.js', baseUrl: 'http://127.0.0.1:3000' };

function issuesOf(input: unknown): string[] {
  try {
    validateConfig(input, CONFIG_PATH);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected validation to fail');
}

describe('validateConfig', () => {
  it('applies defaults to a minimal configuration', () => {
    const config = validateConfig(
      { service, checks: { eventLoop: { path: '/report' } } },
      CONFIG_PATH,
    );
    expect(config.rootDir).toBe('/project');
    expect(config.service).toEqual({
      command: 'node server.js',
      cwd: '/project',
      baseUrl: 'http://127.0.0.1:3000',
      healthPath: '/health',
      startupTimeoutMs: 10_000,
      env: {},
    });
    expect(config.checks.eventLoop).toMatchObject({
      request: { method: 'GET', path: '/report', headers: {}, body: null },
      requests: 20,
      concurrency: 5,
      maxP99Ms: 100,
      resolutionMs: 10,
    });
    expect(config.checks.backpressure).toBeNull();
    expect(config.checks.concurrency).toEqual([]);
  });

  it('reports a non-positive threshold as a plain sentence', () => {
    expect(issuesOf({ service, checks: { eventLoop: { path: '/', maxP99Ms: 0 } } })).toEqual([
      'checks.eventLoop.maxP99Ms must be greater than 0.',
    ]);
  });

  it('collects every problem instead of stopping at the first', () => {
    const issues = issuesOf({
      service: { baseUrl: 'localhost:3000' },
      checks: { eventLoop: { path: 'report', requests: 1.5 } },
    });
    expect(issues).toEqual([
      'service.command is required.',
      'service.baseUrl must be a valid URL such as "http://127.0.0.1:3000" (got "localhost:3000").',
      'checks.eventLoop.path must start with "/" (got "report").',
      'checks.eventLoop.requests must be a whole number.',
    ]);
  });

  it('suggests the closest option for a typo', () => {
    expect(issuesOf({ service, checks: { eventLoop: { path: '/', maxP99: 50 } } })).toEqual([
      'checks.eventLoop.maxP99 is not a known option. Did you mean "maxP99Ms"?',
    ]);
  });

  it('rejects https and malformed URLs', () => {
    expect(
      issuesOf({ service: { ...service, baseUrl: 'https://example.com' }, checks: {} }),
    ).toContain(
      'service.baseUrl must use http:// (got "https://"). HTTPS targets are not supported yet.',
    );
    expect(issuesOf({ service: { ...service, baseUrl: 'not a url' }, checks: {} })).toContain(
      'service.baseUrl must be a valid URL such as "http://127.0.0.1:3000" (got "not a url").',
    );
  });

  it('requires at least one enabled check', () => {
    expect(issuesOf({ service, checks: { eventLoop: { enabled: false } } })).toEqual([
      'checks must enable at least one check.',
    ]);
  });

  it('skips validation of disabled sections so placeholders are allowed', () => {
    const config = validateConfig(
      {
        service,
        checks: { eventLoop: { path: '/' }, retryStorm: { enabled: false, anything: true } },
      },
      CONFIG_PATH,
    );
    expect(config.checks.retryStorm).toBeNull();
  });

  it('serializes JSON bodies and keeps explicit content types', () => {
    const config = validateConfig(
      {
        service,
        checks: {
          concurrency: [
            {
              name: 'json',
              request: { method: 'post', path: '/a', body: { quantity: 1 } },
              assert: { maxSuccesses: 1 },
            },
            {
              name: 'text',
              request: {
                method: 'PUT',
                path: '/b',
                headers: { 'Content-Type': 'text/csv' },
                body: 'a,b',
              },
              assert: { status: [200, 201], minSuccesses: 1 },
            },
          ],
        },
      },
      CONFIG_PATH,
    );
    const [json, text] = config.checks.concurrency;
    expect(json?.request).toEqual({
      method: 'POST',
      path: '/a',
      headers: {},
      body: { contentType: 'application/json', data: '{"quantity":1}' },
    });
    expect(json?.assert).toEqual({ status: null, maxSuccesses: 1, minSuccesses: null });
    expect(text?.request.headers).toEqual({ 'content-type': 'text/csv' });
    expect(text?.request.body).toEqual({ contentType: 'text/csv', data: 'a,b' });
    expect(text?.assert.status).toEqual([200, 201]);
  });

  it('validates concurrency scenarios', () => {
    const issues = issuesOf({
      service,
      checks: {
        concurrency: [
          { name: 'a', request: { path: '/x' }, requests: 5, assert: {} },
          { name: 'a', request: { path: '/x' }, assert: { maxSuccesses: 1, minSuccesses: 2 } },
          { name: 'b', request: { path: '/x' }, requests: 3, assert: { maxSuccesses: 4 } },
        ],
      },
    });
    expect(issues).toEqual([
      'checks.concurrency[0].assert must set maxSuccesses and/or minSuccesses.',
      'checks.concurrency[1].assert.minSuccesses must not be greater than maxSuccesses.',
      'checks.concurrency[1].name "a" is used by more than one scenario.',
      'checks.concurrency[2].assert.maxSuccesses must not be greater than requests (3).',
    ]);
  });

  it('validates the retry storm dependency and fault', () => {
    const issues = issuesOf({
      service,
      checks: {
        retryStorm: {
          dependency: { env: 'PAYMENTS-URL', target: 'http://127.0.0.1:4001' },
          trigger: { path: '/checkout' },
          fault: { type: 'reset', status: 503 },
        },
      },
    });
    expect(issues).toEqual([
      'checks.retryStorm.dependency.env must be a valid environment variable name (got "PAYMENTS-URL").',
      'checks.retryStorm.fault.status is only used when fault.type is "status".',
    ]);
  });

  it('defaults trigger concurrency to the number of requests', () => {
    const config = validateConfig(
      {
        service,
        checks: {
          retryStorm: {
            dependency: { env: 'PAYMENTS_URL', target: 'http://127.0.0.1:4001/api/' },
            trigger: { method: 'POST', path: '/checkout', requests: 7 },
          },
        },
      },
      CONFIG_PATH,
    );
    expect(config.checks.retryStorm).toMatchObject({
      dependency: { env: 'PAYMENTS_URL', target: 'http://127.0.0.1:4001/api' },
      trigger: { requests: 7, concurrency: 7 },
      fault: { type: 'status', status: 503, durationMs: 3000 },
      maxAmplification: 3,
    });
  });

  it('accepts the generated template', () => {
    const config = validateConfig(createConfigTemplate('npm start'), CONFIG_PATH);
    expect(config.service.command).toBe('npm start');
    expect(config.checks.eventLoop).not.toBeNull();
    expect(config.checks.gracefulShutdown).not.toBeNull();
    expect(config.checks.backpressure).toBeNull();
    expect(config.checks.concurrency).toEqual([]);
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('explains how to create a missing file', async () => {
    await expect(loadConfig(undefined, dir)).rejects.toBeInstanceOf(ConfigNotFoundError);
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/resilience-check init/);
  });

  it('reports invalid JSON without a stack trace', async () => {
    await writeFile(join(dir, 'resiliencecheck.config.json'), '{ "service": ');
    const error = await loadConfig(undefined, dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues[0]).toMatch(/^The file is not valid JSON: /);
  });

  it('resolves service.cwd relative to the config file', async () => {
    await writeFile(
      join(dir, 'custom.json'),
      JSON.stringify({ service: { ...service, cwd: 'app' }, checks: { eventLoop: { path: '/' } } }),
    );
    const config = await loadConfig('custom.json', dir);
    expect(config.service.cwd).toBe(join(dir, 'app'));
  });
});
