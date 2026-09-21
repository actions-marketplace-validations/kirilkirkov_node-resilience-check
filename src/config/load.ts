import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { ResolvedConfig } from './types.js';
import { ConfigError, validateConfig } from './validate.js';

export const DEFAULT_CONFIG_FILE = 'resiliencecheck.config.json';

export class ConfigNotFoundError extends Error {
  constructor(readonly file: string) {
    super(
      `No configuration file found at ${displayPath(file)}.\n` +
        'Run "resilience-check init" to create one, or pass --config <path>.',
    );
    this.name = 'ConfigNotFoundError';
  }
}

export function displayPath(file: string, cwd = process.cwd()): string {
  const rel = relative(cwd, file);
  return rel.startsWith('..') ? file : `./${rel}`;
}

export function resolveConfigPath(path: string | undefined, cwd = process.cwd()): string {
  return resolve(cwd, path ?? DEFAULT_CONFIG_FILE);
}

export async function loadConfig(path?: string, cwd = process.cwd()): Promise<ResolvedConfig> {
  const file = resolveConfigPath(path, cwd);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigNotFoundError(file);
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError([`The file is not valid JSON: ${reason}`], file);
  }
  return validateConfig(json, file);
}
