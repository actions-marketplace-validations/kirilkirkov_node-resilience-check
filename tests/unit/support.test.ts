import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { parseOnly, parseSeed } from '../../src/cli/program.js';
import { checkNodeVersion } from '../../src/cli/commands/doctor.js';
import { detectStartCommand } from '../../src/config/template.js';
import { exitCodeFor, summarize } from '../../src/runner/report.js';
import { buildServiceEnv, mergeNodeOptions } from '../../src/runner/service.js';
import { formatCount, formatMs, formatRatio, plural } from '../../src/shared/format.js';
import { ENV_FEATURES, ENV_REPORTER, ENV_TOKEN } from '../../src/shared/protocol.js';
import { createRandom, deriveSeed, generateSeed } from '../../src/shared/random.js';
import { classifyFrame, formatFrameLocation, parseStack } from '../../src/shared/stack.js';
import { settlesWithin } from '../../src/shared/time.js';
import type { CheckResult } from '../../src/checks/types.js';

describe('seeded random', () => {
  it('is deterministic for a seed', () => {
    const a = createRandom(492813);
    const b = createRandom(492813);
    const first = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(createRandom(1).next()).not.toBe(createRandom(2).next());
  });

  it('produces integers within inclusive bounds', () => {
    const random = createRandom(7);
    const values = Array.from({ length: 1000 }, () => random.int(0, 3));
    expect(new Set(values)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('derives independent, stable per-scenario seeds', () => {
    expect(deriveSeed(42, 'reserve-stock')).toBe(deriveSeed(42, 'reserve-stock'));
    expect(deriveSeed(42, 'reserve-stock')).not.toBe(deriveSeed(42, 'transfer'));
    expect(deriveSeed(42, 'x')).toBeGreaterThanOrEqual(0);
  });

  it('generates readable six-digit seeds', () => {
    const seed = generateSeed();
    expect(seed).toBeGreaterThanOrEqual(100_000);
    expect(seed).toBeLessThan(1_000_000);
  });
});

describe('stack parsing', () => {
  const stack = [
    'Error',
    '    at Writable.write (node:internal/streams/writable:510:12)',
    '    at exportUsers (file:///app/src/export-users.js:15:9)',
    '    at async Server.handle (/app/src/http.js:39:11)',
    '    at /app/node_modules/express/lib/router.js:10:3',
    '    at new Promise (<anonymous>)',
    '    at /opt/rc/dist/agent/index.js:1:1',
  ].join('\n');

  it('parses V8 frames including file URLs and async frames', () => {
    expect(parseStack(stack)).toEqual([
      { fn: 'Writable.write', file: 'node:internal/streams/writable', line: 510, column: 12 },
      { fn: 'exportUsers', file: '/app/src/export-users.js', line: 15, column: 9 },
      { fn: 'Server.handle', file: '/app/src/http.js', line: 39, column: 11 },
      { fn: null, file: '/app/node_modules/express/lib/router.js', line: 10, column: 3 },
      { fn: null, file: '/opt/rc/dist/agent/index.js', line: 1, column: 1 },
    ]);
  });

  it('classifies frames by origin', () => {
    const origins = parseStack(stack).map((frame) => classifyFrame(frame, '/opt/rc/dist/'));
    expect(origins).toEqual(['internal', 'application', 'application', 'dependency', 'self']);
  });

  it('formats locations relative to the project root', () => {
    const frame = { fn: null, file: '/app/src/export-users.js', line: 15, column: 9 };
    expect(formatFrameLocation(frame, '/app')).toBe('src/export-users.js:15');
    expect(formatFrameLocation(frame, '/elsewhere')).toBe('/app/src/export-users.js:15');
  });
});

describe('service environment', () => {
  it('appends the agent to existing NODE_OPTIONS', () => {
    expect(mergeNodeOptions(undefined, 'file:///a.js')).toBe('--import=file:///a.js');
    expect(mergeNodeOptions('  ', 'file:///a.js')).toBe('--import=file:///a.js');
    expect(mergeNodeOptions('--max-old-space-size=512', 'file:///a.js')).toBe(
      '--max-old-space-size=512 --import=file:///a.js',
    );
  });

  it('layers config env and overrides on top of the parent env', () => {
    const env = buildServiceEnv(
      { PATH: '/bin', NODE_OPTIONS: '--enable-source-maps', PAYMENTS_URL: 'http://real' },
      {
        config: {
          command: 'node server.js',
          cwd: '/app',
          baseUrl: 'http://127.0.0.1:3000',
          healthPath: '/health',
          startupTimeoutMs: 1000,
          env: { PORT: '3000' },
        },
        agentUrl: 'file:///agent.js',
        reporterUrl: 'http://127.0.0.1:9',
        token: 'secret',
        features: ['backpressure'],
        overrides: { PAYMENTS_URL: 'http://127.0.0.1:5555' },
      },
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      PORT: '3000',
      PAYMENTS_URL: 'http://127.0.0.1:5555',
      NODE_OPTIONS: '--enable-source-maps --import=file:///agent.js',
      [ENV_REPORTER]: 'http://127.0.0.1:9',
      [ENV_TOKEN]: 'secret',
      [ENV_FEATURES]: 'backpressure',
    });
  });
});

describe('formatting', () => {
  it('formats durations, counts and ratios', () => {
    expect(formatMs(3.21)).toBe('3.2ms');
    expect(formatMs(284.4)).toBe('284ms');
    expect(formatMs(1234)).toBe('1.2s');
    expect(formatCount(19832)).toBe('19,832');
    expect(plural(1, 'write')).toBe('1 write');
    expect(plural(143, 'write')).toBe('143 writes');
    expect(formatRatio(6.85)).toBe('6.85x');
  });
});

describe('report summary', () => {
  const result = (status: CheckResult['status']): CheckResult => ({
    id: 'event-loop',
    name: 'Event loop',
    status,
    summary: '',
    details: [],
    metrics: null,
    durationMs: 1,
  });

  it('counts statuses', () => {
    expect(
      summarize(
        ['pass', 'fail', 'warn', 'skip', 'error', 'pass'].map((s) =>
          result(s as CheckResult['status']),
        ),
      ),
    ).toEqual({
      total: 6,
      passed: 2,
      failed: 1,
      warnings: 1,
      skipped: 1,
      errors: 1,
    });
  });

  it('maps outcomes to CI exit codes', () => {
    expect(
      exitCodeFor(summarize([result('pass'), result('warn'), result('skip')]), false, false),
    ).toBe(0);
    expect(exitCodeFor(summarize([result('pass'), result('fail')]), false, false)).toBe(1);
    expect(exitCodeFor(summarize([result('error')]), false, false)).toBe(1);
    expect(exitCodeFor(summarize([]), true, false)).toBe(2);
    expect(exitCodeFor(summarize([result('pass')]), false, true)).toBe(2);
  });
});

describe('CLI argument parsing', () => {
  it('accepts whole-number seeds only', () => {
    expect(parseSeed('492813')).toBe(492813);
    expect(parseSeed('0')).toBe(0);
    expect(() => parseSeed('-1')).toThrow(InvalidArgumentError);
    expect(() => parseSeed('1.5')).toThrow(InvalidArgumentError);
    expect(() => parseSeed('99999999999')).toThrow(InvalidArgumentError);
  });

  it('validates --only check ids', () => {
    expect(parseOnly('event-loop, concurrency')).toEqual(['event-loop', 'concurrency']);
    expect(() => parseOnly('eventLoop')).toThrow(/comma-separated list of/);
    expect(() => parseOnly(',')).toThrow(InvalidArgumentError);
  });
});

describe('doctor', () => {
  it('checks the Node.js version', () => {
    expect(checkNodeVersion('v22.12.0').status).toBe('ok');
    expect(checkNodeVersion('v24.1.0').status).toBe('ok');
    expect(checkNodeVersion('v22.11.0').status).toBe('fail');
    expect(checkNodeVersion('v20.19.0').status).toBe('fail');
  });
});

describe('detectStartCommand', () => {
  it('prefers the start script and the lockfile package manager', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-detect-'));
    try {
      expect(await detectStartCommand(dir)).toBe('node index.js');
      await writeFile(join(dir, 'package.json'), JSON.stringify({ main: 'app.js' }));
      expect(await detectStartCommand(dir)).toBe('node app.js');
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { start: 'node app.js' } }),
      );
      expect(await detectStartCommand(dir)).toBe('npm start');
      await writeFile(join(dir, 'pnpm-lock.yaml'), '');
      expect(await detectStartCommand(dir)).toBe('pnpm start');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('settlesWithin', () => {
  it('reports whether a promise settled in time', async () => {
    expect(await settlesWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error('x')), 50)).toBe(true);
    expect(await settlesWithin(new Promise(() => undefined), 10)).toBe(false);
  });
});
