import type { CheckResult, CheckStatus } from '../checks/types.js';
import type { FatalError, RunReport } from '../runner/report.js';
import { formatMs } from '../shared/format.js';
import { TAGLINE } from '../version.js';
import type { Style } from './style.js';

const SYMBOLS: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✗',
  warn: '!',
  skip: '-',
  error: '✗',
};

const RULE = '─'.repeat(52);

function colorFor(style: Style, status: CheckStatus): (text: string) => string {
  switch (status) {
    case 'pass':
      return style.green;
    case 'warn':
      return style.yellow;
    case 'skip':
      return style.dim;
    default:
      return style.red;
  }
}

export interface HeaderInfo {
  version: string;
  command: string;
  baseUrl: string;
  seed: number;
}

export function renderHeader(style: Style, info: HeaderInfo): string {
  return [
    style.bold(`ResilienceCheck v${info.version}`),
    style.dim(TAGLINE),
    '',
    `${style.dim('Service')}   ${info.baseUrl}`,
    `${style.dim('Command')}   ${info.command}`,
    `${style.dim('Seed')}      ${info.seed}`,
    '',
  ].join('\n');
}

export function renderServiceReady(style: Style, pid: number | null, agent: boolean): string {
  const agentNote = agent
    ? 'agent attached'
    : style.yellow('agent not detected (event loop and backpressure checks need it)');
  return `${style.dim('Ready')}     ${style.dim(`pid ${pid ?? 'unknown'} ·`)} ${agent ? style.dim(agentNote) : agentNote}\n`;
}

/** Column width for check names, so summaries line up. */
export function nameColumnWidth(names: string[]): number {
  const longest = Math.max(0, ...names.map((name) => name.length));
  return Math.min(Math.max(longest + 2, 20), 36);
}

export function renderCheckResult(style: Style, result: CheckResult, nameWidth: number): string {
  const color = colorFor(style, result.status);
  const name = result.name.length >= nameWidth ? `${result.name}  ` : result.name.padEnd(nameWidth);
  const lines = [`${color(SYMBOLS[result.status])} ${style.bold(name)}${result.summary}`];
  for (const detail of result.details) {
    const text =
      detail.startsWith('Heuristic:') || detail.startsWith('│') ? style.dim(detail) : detail;
    lines.push(`    ${text}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderFatalError(style: Style, error: FatalError): string {
  const lines = [`${style.red('✗')} ${style.bold('Could not run the checks')}`];
  for (const line of error.message.split('\n')) lines.push(`    ${line}`);
  if (error.serviceOutput.length > 0) {
    lines.push('', `    ${style.dim('Last service output:')}`);
    for (const line of error.serviceOutput) lines.push(style.dim(`    │ ${line}`));
  }
  return `${lines.join('\n')}\n`;
}

function headline(style: Style, report: RunReport): string {
  const { summary } = report;
  if (report.aborted) return style.yellow('Interrupted before all checks finished.');
  if (report.fatalError) return style.red('No checks were run.');
  const problems = summary.failed + summary.errors;
  if (problems > 0) {
    return style.red(
      style.bold(`${problems} resilience ${problems === 1 ? 'problem' : 'problems'} detected.`),
    );
  }
  if (summary.warnings > 0) {
    return style.yellow(
      `No failures, ${summary.warnings} ${summary.warnings === 1 ? 'warning' : 'warnings'}.`,
    );
  }
  return style.green(style.bold('All checks passed.'));
}

export function renderSummary(style: Style, report: RunReport, jsonPath: string | null): string {
  const { summary } = report;
  const counts = [
    `${summary.passed} passed`,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.errors > 0 ? `${summary.errors} errored` : null,
    summary.warnings > 0 ? `${summary.warnings} warned` : null,
    summary.skipped > 0 ? `${summary.skipped} skipped` : null,
    formatMs(report.durationMs),
  ].filter((part): part is string => part !== null);

  const lines = [
    '',
    style.dim(RULE),
    '',
    headline(style, report),
    style.dim(counts.join(' · ')),
    style.dim(`Reproduce this run with --seed ${report.seed}`),
  ];
  if (jsonPath) lines.push('', `${style.dim('Report')}    ${jsonPath}`);
  return `${lines.join('\n')}\n`;
}
