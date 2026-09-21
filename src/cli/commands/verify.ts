import type { CheckId } from '../../checks/types.js';
import { displayPath, loadConfig } from '../../config/load.js';
import type { ResolvedConfig } from '../../config/types.js';
import { writeJsonReport } from '../../reporter/json.js';
import { createStyle, shouldUseColor, type Style } from '../../reporter/style.js';
import {
  nameColumnWidth,
  renderCheckResult,
  renderFatalError,
  renderHeader,
  renderServiceReady,
  renderSummary,
} from '../../reporter/terminal.js';
import { planChecks } from '../../runner/plan.js';
import { runVerify, type RunEvent } from '../../runner/run.js';
import type { ServiceProcess } from '../../runner/service.js';
import { generateSeed } from '../../shared/random.js';
import { VERSION } from '../../version.js';
import { renderConfigProblem } from '../errors.js';

export interface VerifyCommandOptions {
  config: string;
  seed?: number;
  json?: string;
  only?: CheckId[];
  verbose?: boolean;
  color: boolean;
}

const CLEAR_LINE = '\r\u001b[2K';

/**
 * Prints results as they arrive. On a TTY a transient "running…" line is
 * shown for the current step and replaced by its result.
 */
function createLiveOutput(out: NodeJS.WriteStream, style: Style, nameWidth: number) {
  const interactive = out.isTTY === true;
  let transient = false;
  const showTransient = (text: string): void => {
    if (!interactive) return;
    out.write(`${CLEAR_LINE}${style.dim(text)}`);
    transient = true;
  };
  const write = (text: string): void => {
    if (transient) {
      out.write(CLEAR_LINE);
      transient = false;
    }
    out.write(text);
  };
  return {
    write,
    handle(event: RunEvent): void {
      switch (event.type) {
        case 'service-starting':
          showTransient('  starting service…');
          break;
        case 'service-ready':
          write(`${renderServiceReady(style, event.pid, event.agent)}\n`);
          break;
        case 'check-start':
          showTransient(`  running ${event.name}…`);
          break;
        case 'check-result':
          write(renderCheckResult(style, event.result, nameWidth));
          break;
      }
    },
  };
}

async function loadOrReport(path: string, style: Style): Promise<ResolvedConfig | null> {
  try {
    return await loadConfig(path);
  } catch (error) {
    const rendered = renderConfigProblem(style, error);
    if (rendered === null) throw error;
    process.stderr.write(rendered);
    return null;
  }
}

export async function verifyCommand(options: VerifyCommandOptions): Promise<number> {
  const out = process.stdout;
  const style = createStyle(shouldUseColor(out, process.env, options.color));
  const config = await loadOrReport(options.config, style);
  if (!config) return 2;

  const only = options.only ?? null;
  const plan = planChecks(config.checks, only);
  if (plan.length === 0) {
    process.stderr.write(`${style.red('✗')} --only matched none of the enabled checks.\n`);
    return 2;
  }

  const seed = options.seed ?? generateSeed();
  const live = createLiveOutput(out, style, nameColumnWidth(plan.map((check) => check.name)));
  const controller = new AbortController();
  let service: ServiceProcess | null = null;

  const onSignal = (): void => {
    if (controller.signal.aborted) {
      // Second Ctrl+C: stop waiting for a graceful cleanup.
      service?.killSync();
      process.exit(130);
    }
    live.write(`\n${style.yellow('Interrupted — stopping the service…')}\n`);
    controller.abort();
  };
  // Last line of defence: never leave the service running after we exit.
  const onExit = (): void => service?.killSync();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', onExit);

  live.write(
    renderHeader(style, {
      version: VERSION,
      command: config.service.command,
      baseUrl: config.service.baseUrl,
      seed,
    }),
  );

  try {
    const report = await runVerify({
      config,
      seed,
      only,
      signal: controller.signal,
      onEvent: live.handle,
      ...(options.verbose
        ? {
            onServiceOutput: (line: string) =>
              process.stderr.write(style.dim(`[service] ${line}\n`)),
          }
        : {}),
      onServiceSpawn: (spawned) => {
        service = spawned;
      },
    });

    if (report.fatalError) live.write(renderFatalError(style, report.fatalError));
    let jsonPath: string | null = null;
    if (options.json) jsonPath = displayPath(await writeJsonReport(options.json, report));
    live.write(renderSummary(style, report, jsonPath));
    return report.aborted ? 130 : report.exitCode;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', onExit);
  }
}
