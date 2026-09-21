import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../../src/checks/types.js';
import { buildReport } from '../../src/runner/report.js';
import { createStyle, shouldUseColor } from '../../src/reporter/style.js';
import {
  nameColumnWidth,
  renderCheckResult,
  renderFatalError,
  renderHeader,
  renderSummary,
} from '../../src/reporter/terminal.js';

const plain = createStyle(false);

const failed: CheckResult = {
  id: 'backpressure',
  name: 'Backpressure',
  status: 'fail',
  summary: '143 writes after write() returned false',
  details: ['Source: src/exportUsers.ts:84', 'Heuristic: something cautious'],
  metrics: null,
  durationMs: 10,
};

describe('shouldUseColor', () => {
  it('uses color only on a TTY', () => {
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
    expect(shouldUseColor({}, {})).toBe(false);
  });

  it('honours NO_COLOR, FORCE_COLOR, TERM=dumb and --no-color', () => {
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
    expect(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(shouldUseColor({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, {}, false)).toBe(false);
  });
});

describe('terminal rendering', () => {
  it('emits no escape codes when color is off', () => {
    expect(renderCheckResult(plain, failed, 20).includes('\u001b[')).toBe(false);
    expect(renderCheckResult(createStyle(true), failed, 20)).toContain('\u001b[31m✗');
  });

  it('aligns summaries and indents details', () => {
    expect(renderCheckResult(plain, failed, 20)).toBe(
      [
        '✗ Backpressure        143 writes after write() returned false',
        '    Source: src/exportUsers.ts:84',
        '    Heuristic: something cautious',
        '',
      ].join('\n'),
    );
    expect(renderCheckResult(plain, { ...failed, status: 'pass', details: [] }, 20)).toBe(
      '✓ Backpressure        143 writes after write() returned false\n',
    );
  });

  it('keeps long names readable', () => {
    const width = nameColumnWidth(['Event loop', 'Concurrency: reserve-stock']);
    expect(width).toBe(28);
    const line = renderCheckResult(
      plain,
      { ...failed, name: 'Concurrency: a-very-long-scenario-name-here' },
      width,
    );
    expect(line.startsWith('✗ Concurrency: a-very-long-scenario-name-here  143 writes')).toBe(true);
  });

  it('prints the header with the seed', () => {
    const header = renderHeader(plain, {
      version: '0.1.0',
      command: 'npm start',
      baseUrl: 'http://127.0.0.1:3000',
      seed: 492813,
    });
    expect(header).toContain('ResilienceCheck v0.1.0');
    expect(header).toContain('Break your Node.js service before production does.');
    expect(header).toContain('Seed      492813');
  });

  it('summarizes problems and the report path', () => {
    const report = buildReport({
      seed: 492813,
      startedAt: new Date(0),
      durationMs: 3812,
      command: 'npm start',
      baseUrl: 'http://127.0.0.1:3000',
      pid: 1,
      agent: true,
      checks: [
        failed,
        { ...failed, status: 'pass' },
        { ...failed, status: 'fail' },
        { ...failed, status: 'error' },
      ],
      fatalError: null,
      aborted: false,
    });
    const text = renderSummary(plain, report, './resiliencecheck-report.json');
    expect(text).toContain('3 resilience problems detected.');
    expect(text).toContain('1 passed · 2 failed · 1 errored · 3.8s');
    expect(text).toContain('Reproduce this run with --seed 492813');
    expect(text).toContain('Report    ./resiliencecheck-report.json');
  });

  it('shows service output for fatal errors', () => {
    const text = renderFatalError(plain, {
      message: 'The service exited during startup (exit code 1).',
      serviceOutput: ['Error: Cannot find module x'],
    });
    expect(text).toContain('Could not run the checks');
    expect(text).toContain('│ Error: Cannot find module x');
  });
});
