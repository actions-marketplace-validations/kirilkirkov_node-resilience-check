import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import type { RunReport } from '../../src/runner/report.js';
import { isPidAlive } from '../../src/runner/service.js';
import { VERSION } from '../../src/version.js';
import { exampleConfig, freePort, isPortFree, ROOT, runCli, startCli, tempDir } from './helpers.js';

let workspace: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => {
  workspace = await tempDir();
});
afterEach(async () => {
  await workspace.cleanup();
});

async function writeConfig(config: unknown): Promise<string> {
  const path = join(workspace.dir, 'resiliencecheck.config.json');
  await writeFile(path, JSON.stringify(config));
  return path;
}

describe('general commands', () => {
  it('prints the version', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it('prints help for the program and for verify', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Break your Node.js service before production does.');
    for (const command of ['init', 'verify', 'doctor']) expect(help.stdout).toContain(command);

    const verifyHelp = await runCli(['verify', '--help']);
    expect(verifyHelp.stdout).toContain('--seed <number>');
    expect(verifyHelp.stdout).toContain('--json <path>');
    expect(verifyHelp.stdout).toContain('Exit codes:');
  });

  it('rejects unknown options with exit code 2', async () => {
    const result = await runCli(['verify', '--seed', 'abc']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('must be a whole number');
  });
});

describe('init', () => {
  it('writes a valid starter config and refuses to overwrite it', async () => {
    await writeFile(
      join(workspace.dir, 'package.json'),
      JSON.stringify({ scripts: { start: 'node app.js' } }),
    );
    const first = await runCli(['init'], { cwd: workspace.dir });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Created ./resiliencecheck.config.json');

    const config = await loadConfig(undefined, workspace.dir);
    expect(config.service.command).toBe('npm start');

    const second = await runCli(['init'], { cwd: workspace.dir });
    expect(second.code).toBe(2);
    expect(second.stderr).toContain('already exists. Use --force');

    const forced = await runCli(['init', '--force'], { cwd: workspace.dir });
    expect(forced.code).toBe(0);
  });
});

describe('verify: configuration problems', () => {
  it('explains how to create a missing config', async () => {
    const result = await runCli(['verify'], { cwd: workspace.dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No configuration file found');
    expect(result.stderr).toContain('resilience-check init');
  });

  it('lists validation problems as plain sentences', async () => {
    await writeConfig({
      service: { command: 'node server.js', baseUrl: 'http://127.0.0.1:3000' },
      checks: { eventLoop: { path: '/', maxP99Ms: 0 } },
    });
    const result = await runCli(['verify'], { cwd: workspace.dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Invalid configuration');
    expect(result.stderr).toContain('checks.eventLoop.maxP99Ms must be greater than 0.');
    expect(result.stderr).not.toContain('at ');
  });

  it('rejects --only values that match no enabled check', async () => {
    await writeConfig({
      service: { command: 'node server.js', baseUrl: 'http://127.0.0.1:3000' },
      checks: { eventLoop: { path: '/' } },
    });
    const result = await runCli(['verify', '--only', 'concurrency'], { cwd: workspace.dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--only matched none of the enabled checks');
  });
});

describe('verify: service lifecycle', () => {
  it('reports a service that crashes during startup, with its output', async () => {
    const port = await freePort();
    await writeConfig({
      service: {
        command: `node -e "console.error('boom: missing DATABASE_URL'); process.exit(3)"`,
        baseUrl: `http://127.0.0.1:${port}`,
      },
      checks: { eventLoop: { path: '/' } },
    });
    const result = await runCli(['verify'], { cwd: workspace.dir });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('The service exited during startup (exit code 3).');
    expect(result.stdout).toContain('boom: missing DATABASE_URL');
  });

  it('kills a service that never becomes healthy', async () => {
    const port = await freePort();
    const pidFile = join(workspace.dir, 'pid');
    await writeConfig({
      service: {
        command: `node -e "require('fs').writeFileSync(process.env.PID_FILE, String(process.pid)); setInterval(() => {}, 1000)"`,
        baseUrl: `http://127.0.0.1:${port}`,
        startupTimeoutMs: 800,
        env: { PID_FILE: pidFile },
      },
      checks: { eventLoop: { path: '/' } },
    });
    const result = await runCli(['verify'], { cwd: workspace.dir });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('GET /health did not return 2xx within 800ms');
    expect(existsSync(pidFile)).toBe(true);
    expect(isPidAlive(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  });

  it('refuses to start when the port is already taken', async () => {
    const blocker = createServer((req, res) => res.end('not your service'));
    blocker.listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const { port } = blocker.address() as { port: number };
    try {
      await writeConfig({
        service: { command: 'node server.js', baseUrl: `http://127.0.0.1:${port}` },
        checks: { eventLoop: { path: '/' } },
      });
      const result = await runCli(['verify'], { cwd: workspace.dir });
      expect(result.code).toBe(2);
      expect(result.stdout).toContain(`Something is already listening on 127.0.0.1:${port}`);
    } finally {
      blocker.close();
    }
  });

  it('fails the check during which the service crashed and skips the rest', async () => {
    const port = await freePort();
    const reportPath = join(workspace.dir, 'report.json');
    await writeConfig({
      service: {
        command: 'node crashing-service.js',
        cwd: join(ROOT, 'tests/fixtures'),
        baseUrl: `http://127.0.0.1:${port}`,
        env: { PORT: String(port) },
      },
      checks: {
        eventLoop: { path: '/crash', requests: 1 },
        concurrency: [{ name: 'after-crash', request: { path: '/' }, assert: { minSuccesses: 1 } }],
      },
    });
    const result = await runCli(['verify', '--json', reportPath], { cwd: workspace.dir });
    expect(result.code).toBe(1);
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as RunReport;
    const [crashed, skipped] = report.checks;
    expect(crashed).toMatchObject({ id: 'event-loop', status: 'fail' });
    expect(crashed?.summary).toBe('service exited during the check (exit code 1)');
    expect(crashed?.details).toContain('│ fatal: simulated crash while handling /crash');
    expect(skipped).toMatchObject({ id: 'concurrency', status: 'skip' });
  });

  it('stops the service and exits with 130 on Ctrl+C', async () => {
    const { configPath, port } = await exampleConfig('broken-service', workspace.dir, (config) => {
      // Long enough that the interrupt lands in the middle of the check.
      config.checks.eventLoop.requests = 500;
    });
    const cli = startCli(['verify', '--config', configPath, '--only', 'event-loop']);
    await cli.waitFor('Ready');
    cli.child.kill('SIGINT');
    const result = await cli.result;
    expect(result.code).toBe(130);
    expect(result.stdout).toContain('Interrupted');
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('doctor', () => {
  it('validates the environment and configuration', async () => {
    const { configPath } = await exampleConfig('broken-service', workspace.dir);
    const result = await runCli(['doctor', '--config', configPath]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain(`Node.js ${process.version}`);
    expect(result.stdout).toContain('Configuration is valid (5 checks enabled)');
    expect(result.stdout).toMatch(/"node" found at /);
  });

  it('fails for an invalid configuration', async () => {
    await writeConfig({ service: { command: 'node x.js' } });
    const result = await runCli(['doctor'], { cwd: workspace.dir });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('service.baseUrl is required.');
  });
});
