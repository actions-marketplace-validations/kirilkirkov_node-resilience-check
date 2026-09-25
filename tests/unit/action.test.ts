import { describe, expect, it } from 'vitest';
import type { VerifyCommandOptions } from '../../src/cli/commands/verify.js';
import { runAction, type ActionIo } from '../../src/action/run.js';

const WORKSPACE = '/home/runner/work/app/app';

function fakeIo(inputs: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const failures: string[] = [];
  const io: ActionIo = {
    getInput: (name) => inputs[name] ?? '',
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    setFailed: (message) => {
      failures.push(message);
    },
  };
  return { io, outputs, failures };
}

async function run(
  inputs: Record<string, string> = {},
  verify: (options: VerifyCommandOptions) => Promise<number> = async () => 0,
) {
  const { io, outputs, failures } = fakeIo(inputs);
  const calls: VerifyCommandOptions[] = [];
  const directories: string[] = [];
  const code = await runAction({
    io,
    workspace: WORKSPACE,
    agentUrl: 'file:///action/dist/action/agent.js',
    chdir: (directory) => directories.push(directory),
    verify: async (options) => {
      calls.push(options);
      return verify(options);
    },
  });
  return { code, outputs, failures, calls, directories };
}

describe('GitHub Action inputs', () => {
  it('uses the CLI defaults when no inputs are given', async () => {
    const { calls } = await run();
    expect(calls).toEqual([
      {
        config: 'resiliencecheck.config.json',
        color: true,
        verbose: false,
        agentUrl: 'file:///action/dist/action/agent.js',
      },
    ]);
  });

  it('passes a custom config path, checks, seed, verbose flag and report path', async () => {
    const { calls } = await run({
      config: 'ci/resilience.json',
      only: 'event-loop, graceful-shutdown',
      seed: '42',
      verbose: 'true',
      'report-path': 'reports/resilience.json',
    });
    expect(calls[0]).toMatchObject({
      config: 'ci/resilience.json',
      only: ['event-loop', 'graceful-shutdown'],
      seed: 42,
      verbose: true,
      json: 'reports/resilience.json',
    });
  });

  it.each([
    ['seed', 'abc', 'must be a whole number'],
    ['only', 'event-loop,unknown', 'comma-separated list'],
    ['verbose', 'yes', 'use true or false'],
  ])('fails on an invalid %s input without running', async (name, value, message) => {
    const { code, calls, failures } = await run({ [name]: value });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(failures[0]).toContain(`Invalid input "${name}"`);
    expect(failures[0]).toContain(message);
  });
});

describe('GitHub Action execution', () => {
  it("runs from the caller's workspace", async () => {
    const { directories } = await run();
    expect(directories).toEqual([WORKSPACE]);
  });

  it('succeeds when every check passes', async () => {
    const { code, failures, outputs } = await run({}, async () => 0);
    expect(code).toBe(0);
    expect(failures).toEqual([]);
    expect(outputs['exit-code']).toBe('0');
  });

  it.each([
    [1, 'found resilience problems'],
    [2, 'configuration or startup problem'],
    [130, 'interrupted'],
  ])('fails the step on exit code %i', async (exitCode, message) => {
    const { code, failures, outputs } = await run({}, async () => exitCode);
    expect(code).toBe(exitCode);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(message);
    expect(outputs['exit-code']).toBe(String(exitCode));
  });

  it('fails the step with the stack on an unexpected exception', async () => {
    const { code, failures } = await run({}, async () => {
      throw new Error('boom');
    });
    expect(code).toBe(2);
    expect(failures[0]).toContain('crashed unexpectedly');
    expect(failures[0]).toContain('boom');
  });
});
