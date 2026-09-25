import { spawn } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunReport } from '../../src/runner/report.js';
import { exampleConfig, ROOT, tempDir, type Example } from './helpers.js';

let workspace: Awaited<ReturnType<typeof tempDir>>;
let actionDir: string;
beforeEach(async () => {
  workspace = await tempDir();
  // Only the committed bundle, as in `uses: kirilkirkov/node-resilience-check@<tag>`.
  actionDir = join(workspace.dir, 'action');
  await cp(join(ROOT, 'dist/action'), join(actionDir, 'dist/action'), { recursive: true });
});
afterEach(async () => {
  await workspace.cleanup();
});

interface ActionResult {
  code: number | null;
  stdout: string;
  stderr: string;
  outputs: string;
}

async function runAction(inputs: Record<string, string>): Promise<ActionResult> {
  const outputFile = join(workspace.dir, 'github-output');
  await writeFile(outputFile, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    GITHUB_WORKSPACE: workspace.dir,
    GITHUB_OUTPUT: outputFile,
  };
  delete env.FORCE_COLOR;
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  const child = spawn(process.execPath, [join(actionDir, 'dist/action/index.js')], {
    cwd: actionDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return { code, stdout, stderr, outputs: await readFile(outputFile, 'utf8') };
}

async function config(example: Example): Promise<string> {
  await exampleConfig(example, workspace.dir);
  return `${example}.json`;
}

describe('bundled GitHub Action', () => {
  it('passes on the fixed example and writes the report into the workspace', async () => {
    const result = await runAction({
      config: await config('fixed-service'),
      seed: '7',
      'report-path': 'reports/resilience.json',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('agent attached');
    expect(result.stdout).toContain('All checks passed.');
    expect(result.stdout).not.toContain('::error::');
    const report = JSON.parse(
      await readFile(join(workspace.dir, 'reports/resilience.json'), 'utf8'),
    ) as RunReport;
    expect(report.seed).toBe(7);
    expect(report.exitCode).toBe(0);
    expect(result.outputs).toContain(join(workspace.dir, 'reports/resilience.json'));
  });

  it('fails the step when the broken example has problems', async () => {
    const result = await runAction({
      config: await config('broken-service'),
      only: 'event-loop,backpressure',
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('✗ Backpressure');
    expect(result.stdout).toContain('Source: src/export-users.js');
    expect(result.stdout).toContain('::error::ResilienceCheck found resilience problems');
  });

  it('fails the step when the configuration is missing', async () => {
    const result = await runAction({});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No configuration file found');
    expect(result.stdout).toContain('::error::ResilienceCheck could not run');
  });
});
