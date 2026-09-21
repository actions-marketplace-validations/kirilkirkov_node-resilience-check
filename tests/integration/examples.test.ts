import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunReport } from '../../src/runner/report.js';
import { exampleConfig, isPortFree, runCli, tempDir } from './helpers.js';

type Metrics = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON report

let workspace: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => {
  workspace = await tempDir();
});
afterEach(async () => {
  await workspace.cleanup();
});

async function verify(
  example: 'broken-service' | 'fixed-service',
  extraArgs: string[] = [],
  patch?: (config: Metrics) => void,
) {
  const { configPath, port } = await exampleConfig(example, workspace.dir, patch);
  const reportPath = join(workspace.dir, 'report.json');
  const result = await runCli([
    'verify',
    '--config',
    configPath,
    '--json',
    reportPath,
    ...extraArgs,
  ]);
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as RunReport;
  const checks = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  const metrics = (id: string): Metrics => checks[id]?.metrics as Metrics;
  return { result, report, checks, metrics, port };
}

describe('broken-service example', () => {
  it('detects every intentional problem and exits with 1', async () => {
    const { result, report, checks, metrics, port } = await verify('broken-service', [
      '--seed',
      '1234',
    ]);

    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(report.exitCode).toBe(1);
    expect(report.seed).toBe(1234);
    expect(report.service.agent).toBe(true);
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.status]))).toEqual({
      'event-loop': 'fail',
      backpressure: 'fail',
      'retry-storm': 'fail',
      concurrency: 'fail',
      'graceful-shutdown': 'fail',
    });

    expect(metrics('event-loop').p99Ms).toBeGreaterThan(100);
    expect(metrics('backpressure').ignoredWrites).toBeGreaterThan(1000);
    expect(metrics('backpressure').sites[0].location).toBe('src/export-users.js:15');
    expect(metrics('retry-storm').amplification).toBe(6);
    expect(metrics('retry-storm').timing.jitter).toBe('absent');
    expect(metrics('retry-storm').timing.backoff).toBe('constant');
    expect(metrics('concurrency').rounds[0].successes).toBe(10);
    expect(metrics('graceful-shutdown')).toMatchObject({
      completed: 0,
      dropped: 20,
      signalHandlers: 0,
    });
    expect(checks.backpressure?.details).toContain('Source: src/export-users.js:15');

    expect(result.stdout).toContain('Seed      1234');
    expect(result.stdout).toContain('5 resilience problems detected.');
    expect(result.stdout.includes('\u001b[')).toBe(false);
    // The whole service process group was cleaned up.
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('fixed-service example', () => {
  it('passes every check and exits with 0', async () => {
    const { result, report, metrics, port } = await verify('fixed-service');

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.status]))).toEqual({
      'event-loop': 'pass',
      backpressure: 'pass',
      'retry-storm': 'pass',
      concurrency: 'pass',
      'graceful-shutdown': 'pass',
    });
    expect(metrics('backpressure').backpressureSignals).toBeGreaterThan(0);
    expect(metrics('backpressure').ignoredWrites).toBe(0);
    expect(metrics('retry-storm').amplification).toBeLessThanOrEqual(3);
    expect(metrics('concurrency').rounds[0].successes).toBe(1);
    expect(metrics('graceful-shutdown')).toMatchObject({
      completed: 20,
      dropped: 0,
      timedOut: false,
    });
    expect(result.stdout).toContain('All checks passed.');
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('package-manager wrappers', () => {
  it('finds and signals the Node.js process behind "npm start"', async () => {
    const { result, report, metrics } = await verify(
      'broken-service',
      ['--only', 'graceful-shutdown'],
      (config) => {
        config.service.command = 'npm start --silent';
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(report.service.agent).toBe(true);
    // The listener count comes from the agent inside the node process, not npm.
    expect(metrics('graceful-shutdown')).toMatchObject({ signalHandlers: 0, dropped: 20 });
  });
});
