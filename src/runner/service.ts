import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServiceConfig } from '../config/types.js';
import { sendRequest, type RequestOutcome } from '../http/request.js';
import {
  ENV_FEATURES,
  ENV_REPORTER,
  ENV_TOKEN,
  PROBE_HEADER,
  type AgentFeature,
} from '../shared/protocol.js';
import { settlesWithin } from '../shared/time.js';
import { AgentClient } from './agent-client.js';
import type { ReporterServer } from './reporter-server.js';

const IS_WINDOWS = process.platform === 'win32';
const AGENT_REGISTRATION_TIMEOUT_MS = 3000;
const HEALTH_POLL_INTERVAL_MS = 100;
const OUTPUT_LINES_KEPT = 200;

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ServiceStartError extends Error {
  constructor(
    message: string,
    readonly output: string[] = [],
  ) {
    super(message);
    this.name = 'ServiceStartError';
  }
}

export function describeExit(exit: ExitInfo): string {
  if (exit.signal) return `killed by ${exit.signal}`;
  return `exit code ${exit.code ?? 'unknown'}`;
}

/** Appends the agent preload while keeping the user's own NODE_OPTIONS. */
export function mergeNodeOptions(existing: string | undefined, agentUrl: string): string {
  const flag = `--import=${agentUrl}`;
  const trimmed = existing?.trim() ?? '';
  return trimmed === '' ? flag : `${trimmed} ${flag}`;
}

export interface ServiceEnvOptions {
  config: ServiceConfig;
  agentUrl: string;
  reporterUrl: string;
  token: string;
  features: AgentFeature[];
  /** Applied last, e.g. a dependency URL pointing at the fault proxy. */
  overrides: Record<string, string>;
}

export function buildServiceEnv(
  base: NodeJS.ProcessEnv,
  options: ServiceEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...options.config.env, ...options.overrides };
  env.NODE_OPTIONS = mergeNodeOptions(env.NODE_OPTIONS, options.agentUrl);
  env[ENV_REPORTER] = options.reporterUrl;
  env[ENV_TOKEN] = options.token;
  env[ENV_FEATURES] = options.features.join(',');
  return env;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

class OutputLog {
  private lines: string[] = [];
  private readonly partial = { stdout: '', stderr: '' };

  constructor(private readonly onLine?: (line: string) => void) {}

  push(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const text = this.partial[stream] + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    this.partial[stream] = parts.pop() ?? '';
    for (const line of parts) this.add(line);
  }

  tail(count: number): string[] {
    const pending = [this.partial.stdout, this.partial.stderr].filter((line) => line !== '');
    return [...this.lines, ...pending].slice(-count);
  }

  private add(line: string): void {
    this.lines.push(line);
    if (this.lines.length > OUTPUT_LINES_KEPT) this.lines.shift();
    this.onLine?.(line);
  }
}

/**
 * The service command runs through a shell in its own process group, so the
 * whole tree (npm → sh → node) can be terminated together and nothing is left
 * behind after the CLI exits.
 */
export class ServiceProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<ExitInfo>;
  agent: AgentClient | null = null;
  private exit: ExitInfo | null = null;
  private spawnError: Error | null = null;
  private readonly output: OutputLog;

  constructor(config: ServiceConfig, env: NodeJS.ProcessEnv, onOutput?: (line: string) => void) {
    this.output = new OutputLog(onOutput);
    this.child = spawn(config.command, {
      cwd: config.cwd,
      env,
      shell: true,
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exit = { code, signal };
        resolve(this.exit);
      });
      this.child.once('error', (error) => {
        this.spawnError = error;
        this.exit ??= { code: null, signal: null };
        resolve(this.exit);
      });
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.output.push('stdout', chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.output.push('stderr', chunk));
  }

  /** The Node.js process that serves HTTP (falls back to the shell/wrapper). */
  get targetPid(): number | undefined {
    return this.agent?.pid ?? this.child.pid;
  }

  exitInfo(): ExitInfo | null {
    return this.exit;
  }

  startFailure(): Error | null {
    return this.spawnError;
  }

  isRunning(): boolean {
    if (this.exit !== null) return false;
    return this.agent === null || isPidAlive(this.agent.pid);
  }

  recentOutput(lines = 20): string[] {
    return this.output.tail(lines);
  }

  signalTarget(signal: NodeJS.Signals): void {
    const pid = this.targetPid;
    if (pid !== undefined) process.kill(pid, signal);
  }

  /** Resolves true once the target process is gone, false on timeout. */
  async waitForTargetExit(timeoutMs: number): Promise<boolean> {
    const pid = this.targetPid;
    if (pid === undefined || pid === this.child.pid) {
      return settlesWithin(this.exited, timeoutMs);
    }
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (!isPidAlive(pid)) return true;
      await delay(10);
    }
    return !isPidAlive(pid);
  }

  /** SIGTERM to the whole group, SIGKILL for anything that is left. */
  async stop(): Promise<void> {
    if (this.exit === null) {
      this.signalGroup('SIGTERM');
      if (!(await settlesWithin(this.exited, 3000))) {
        this.signalGroup('SIGKILL');
        await settlesWithin(this.exited, 2000);
      }
    }
    // Grandchildren can outlive the direct child (e.g. when a wrapper exits
    // first), so sweep the group once more.
    this.killSync();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  /** Synchronous last-resort cleanup, safe to call from a process 'exit' hook. */
  killSync(): void {
    if (IS_WINDOWS) {
      if (this.exit === null) this.signalGroup('SIGKILL');
      return;
    }
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    this.signalGroup('SIGKILL');
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (IS_WINDOWS) {
      if (signal === 'SIGKILL') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        this.child.kill(signal);
      }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  }
}

function assertPortFree(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  const port = Number(url.port || 80);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      reject(
        new ServiceStartError(
          `Something is already listening on ${url.hostname}:${port}. ResilienceCheck starts the ` +
            'service itself, so stop the existing process (or change service.baseUrl) to avoid ' +
            'testing the wrong process.',
        ),
      );
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', () => resolve());
  });
}

function describeHealthOutcome(outcome: RequestOutcome): string {
  return outcome.kind === 'response'
    ? `last response: HTTP ${outcome.status}`
    : `last error: ${outcome.message}`;
}

export interface StartServiceOptions {
  config: ServiceConfig;
  env: NodeJS.ProcessEnv;
  token: string;
  reporter: ReporterServer;
  signal: AbortSignal;
  onOutput?: (line: string) => void;
  /** Receives the process as soon as it is spawned, before it is healthy. */
  onSpawn?: (service: ServiceProcess) => void;
}

async function waitUntilHealthy(
  service: ServiceProcess,
  options: StartServiceOptions,
): Promise<void> {
  const { config, signal, token } = options;
  const deadline = performance.now() + config.startupTimeoutMs;
  let lastProblem = 'no response yet';

  for (;;) {
    signal.throwIfAborted();
    const exit = service.exitInfo();
    if (exit) {
      const reason = service.startFailure()?.message ?? describeExit(exit);
      throw new ServiceStartError(
        `The service exited during startup (${reason}).`,
        service.recentOutput(),
      );
    }
    if (performance.now() > deadline) {
      throw new ServiceStartError(
        `GET ${config.healthPath} did not return 2xx within ${config.startupTimeoutMs}ms ` +
          `(${lastProblem}). Check service.baseUrl, service.healthPath and service.startupTimeoutMs.`,
        service.recentOutput(),
      );
    }
    const outcome = await sendRequest(
      config.baseUrl,
      { method: 'GET', path: config.healthPath, headers: {}, body: null },
      { timeoutMs: 2000, signal, headers: { [PROBE_HEADER]: token } },
    );
    if (outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300) return;
    lastProblem = describeHealthOutcome(outcome);
    await Promise.race([delay(HEALTH_POLL_INTERVAL_MS), service.exited]);
  }
}

/**
 * Starts the service, waits for the health endpoint and for the agent inside
 * the serving process to register. A service without a registered agent is
 * still usable; checks that need the agent will report that clearly.
 */
export async function startService(options: StartServiceOptions): Promise<ServiceProcess> {
  if (!existsSync(options.config.cwd)) {
    throw new ServiceStartError(`service.cwd does not exist: ${options.config.cwd}`);
  }
  await assertPortFree(options.config.baseUrl);

  const service = new ServiceProcess(options.config, options.env, options.onOutput);
  options.onSpawn?.(service);
  try {
    await waitUntilHealthy(service, options);
    const registration = await options.reporter.waitForAgent(AGENT_REGISTRATION_TIMEOUT_MS);
    if (registration) service.agent = new AgentClient(registration, options.token);
    return service;
  } catch (error) {
    await service.stop();
    throw error;
  }
}
