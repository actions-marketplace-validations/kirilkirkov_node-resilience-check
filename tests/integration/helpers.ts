import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const CLI = join(ROOT, 'dist/cli/index.js');

export type Example = 'broken-service' | 'fixed-service';

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'resilience-check-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

type JsonObject = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- free-form test config

/**
 * Copies an example's config into `dir`, pointing it at the example sources
 * and at free ports so tests never collide with anything running locally.
 */
export async function exampleConfig(
  example: Example,
  dir: string,
  patch: (config: JsonObject) => void = () => undefined,
): Promise<{ configPath: string; port: number }> {
  const exampleDir = join(ROOT, 'examples', example);
  const config = JSON.parse(
    await readFile(join(exampleDir, 'resiliencecheck.config.json'), 'utf8'),
  ) as JsonObject;
  const port = await freePort();
  const paymentsPort = await freePort();
  config.service.cwd = exampleDir;
  config.service.baseUrl = `http://127.0.0.1:${port}`;
  config.service.env = { PORT: String(port), PAYMENTS_PORT: String(paymentsPort) };
  config.checks.retryStorm.dependency.target = `http://127.0.0.1:${paymentsPort}`;
  patch(config);
  const configPath = join(dir, `${example}.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return { configPath, port };
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunningCli {
  child: ChildProcess;
  result: Promise<CliResult>;
  /** Resolves once stdout contains `text`. */
  waitFor(text: string): Promise<void>;
}

export function startCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RunningCli {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...options.env };
  delete env.FORCE_COLOR;
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const watchers: Array<{ text: string; resolve: () => void }> = [];
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    for (const watcher of watchers) if (stdout.includes(watcher.text)) watcher.resolve();
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const result = new Promise<CliResult>((resolve) => {
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  return {
    child,
    result,
    waitFor: (text) =>
      stdout.includes(text)
        ? Promise.resolve()
        : new Promise((resolve) => watchers.push({ text, resolve })),
  };
}

export function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return startCli(args, options).result;
}
