import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { InvalidArgumentError } from 'commander';
import { verifyCommand, type VerifyCommandOptions } from '../cli/commands/verify.js';
import { parseOnly, parseSeed } from '../cli/program.js';
import { DEFAULT_CONFIG_FILE } from '../config/load.js';

/** The parts of @actions/core the wrapper uses, injectable for tests. */
export interface ActionIo {
  getInput(name: string): string;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
}

export interface ActionEnvironment {
  io: ActionIo;
  /** The caller's checkout; config, service commands and reports are relative to it. */
  workspace: string;
  /** file:// URL of the bundled agent preload. */
  agentUrl?: string;
  verify?: (options: VerifyCommandOptions) => Promise<number>;
  chdir?: (directory: string) => void;
}

const FAILURE_MESSAGES: Record<number, string> = {
  1: 'ResilienceCheck found resilience problems (exit code 1). See the results above.',
  2: 'ResilienceCheck could not run: configuration or startup problem (exit code 2). See the output above.',
  130: 'ResilienceCheck was interrupted (exit code 130).',
};

class InputError extends Error {}

function parseInput<T>(name: string, value: string, parse: (value: string) => T): T {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw new InputError(`Invalid input "${name}": ${error.message}`);
    }
    throw error;
  }
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw new InvalidArgumentError('use true or false.');
}

export function readOptions(io: ActionIo, agentUrl?: string): VerifyCommandOptions {
  const config = io.getInput('config').trim() || DEFAULT_CONFIG_FILE;
  const only = io.getInput('only').trim();
  const seed = io.getInput('seed').trim();
  const reportPath = io.getInput('report-path').trim();
  return {
    config,
    color: true,
    verbose: parseInput('verbose', io.getInput('verbose'), parseBoolean),
    ...(only ? { only: parseInput('only', only, parseOnly) } : {}),
    ...(seed ? { seed: parseInput('seed', seed, parseSeed) } : {}),
    ...(reportPath ? { json: reportPath } : {}),
    ...(agentUrl ? { agentUrl } : {}),
  };
}

/**
 * Runs `resilience-check verify` from the caller's workspace and turns a
 * non-zero exit code into a failed step. Returns the exit code to use.
 */
export async function runAction(environment: ActionEnvironment): Promise<number> {
  const { io, workspace } = environment;
  const verify = environment.verify ?? verifyCommand;
  const chdir = environment.chdir ?? process.chdir;

  let code: number;
  try {
    const options = readOptions(io, environment.agentUrl);
    chdir(workspace);
    code = await verify(options);
    io.setOutput('exit-code', String(code));
    const report = options.json ? resolve(workspace, options.json) : null;
    if (report && existsSync(report)) io.setOutput('report-path', report);
  } catch (error) {
    if (error instanceof InputError) {
      io.setFailed(error.message);
      return 2;
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.setFailed(`ResilienceCheck crashed unexpectedly: ${detail}`);
    return 2;
  }

  if (code !== 0) {
    io.setFailed(FAILURE_MESSAGES[code] ?? `ResilienceCheck exited with code ${code}.`);
  }
  return code;
}
