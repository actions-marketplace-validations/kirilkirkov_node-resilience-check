import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBackpressureTracker,
  installBackpressureTracking,
  type BackpressureTracker,
} from '../../src/agent/backpressure.js';
import {
  evaluateBackpressure,
  toBackpressureMetrics,
  type BackpressureMetrics,
} from '../../src/checks/backpressure.js';
import { slowRead } from '../../src/http/slow-client.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

/** A writable that accepts one chunk per tick, so its buffer fills quickly. */
function slowSink(highWaterMark = 16): Writable {
  return new Writable({
    highWaterMark,
    write(_chunk, _encoding, callback) {
      setImmediate(callback);
    },
  });
}

function writeIgnoringBackpressure(stream: Writable, chunks: number): boolean[] {
  const results: boolean[] = [];
  for (let i = 0; i < chunks; i++) results.push(stream.write('x'.repeat(10)));
  return results;
}

async function writeRespectingBackpressure(stream: Writable, chunks: number): Promise<void> {
  for (let i = 0; i < chunks; i++) {
    if (!stream.write('x'.repeat(10))) await once(stream, 'drain');
  }
}

describe('backpressure tracking', () => {
  let tracker: BackpressureTracker;
  let uninstall: () => void;

  beforeEach(() => {
    tracker = createBackpressureTracker({ selfDir: SRC_DIR });
    uninstall = installBackpressureTracking(tracker);
  });
  afterEach(() => uninstall());

  it('counts writes that happen after write() returned false', async () => {
    const sink = slowSink();
    const results = writeIgnoringBackpressure(sink, 10);
    sink.end();
    await once(sink, 'finish');

    // 10 bytes per chunk and a 16-byte buffer: the second write returns false.
    expect(results[0]).toBe(true);
    expect(results.slice(1).every((result) => result === false)).toBe(true);

    const report = tracker.report();
    expect(report.ignoredWrites).toBe(8);
    expect(report.episodes).toBe(1);
    expect(report.backpressureSignals).toBe(9);
    expect(report.sites).toHaveLength(1);
    const [site] = report.sites;
    expect(site?.attribution).toBe('application');
    expect(site?.streamType).toBe('Writable');
    expect(site?.location?.file).toBe(THIS_FILE);
  });

  it('reports nothing for a producer that waits for drain', async () => {
    const sink = slowSink();
    await writeRespectingBackpressure(sink, 50);
    sink.end();

    const report = tracker.report();
    expect(report.backpressureSignals).toBeGreaterThan(10);
    expect(report.ignoredWrites).toBe(0);
    expect(report.sites).toEqual([]);
  });

  it('treats each wait-for-drain period as a separate episode', async () => {
    const sink = slowSink();
    writeIgnoringBackpressure(sink, 3);
    await once(sink, 'drain');
    writeIgnoringBackpressure(sink, 3);
    await once(sink, 'drain');

    const report = tracker.report();
    expect(report.episodes).toBe(2);
    expect(report.ignoredWrites).toBe(2);
    expect(report.sites[0]?.episodes).toBe(2);
  });

  it('does not flag pipe() or pipeline(), which honour backpressure', async () => {
    const source = Readable.from(Array.from({ length: 200 }, () => 'y'.repeat(64)));
    await pipeline(source, new PassThrough(), slowSink(64));
    const report = tracker.report();
    expect(report.backpressureSignals).toBeGreaterThan(0);
    expect(report.ignoredWrites).toBe(0);
  });

  it('never changes return values or swallows errors', () => {
    const sink = slowSink();
    expect(() => sink.write(null)).toThrow(/null/);
    expect(writeIgnoringBackpressure(sink, 3)).toEqual([true, false, false]);
    sink.destroy();
  });

  it('starts over after reset()', async () => {
    const sink = slowSink();
    writeIgnoringBackpressure(sink, 5);
    expect(tracker.report().ignoredWrites).toBe(3);
    tracker.reset();
    expect(tracker.report().ignoredWrites).toBe(0);
    // The stream is still waiting for drain; new ignored writes count again.
    writeIgnoringBackpressure(sink, 2);
    expect(tracker.report().ignoredWrites).toBe(2);
    sink.destroy();
  });

  it('restores the original prototypes on uninstall', () => {
    uninstall();
    const sink = slowSink();
    writeIgnoringBackpressure(sink, 5);
    expect(tracker.report().ignoredWrites).toBe(0);
    sink.destroy();
    uninstall = installBackpressureTracking(tracker);
  });

  describe('http responses', () => {
    let server: Server;
    let baseUrl: string;

    beforeEach(async () => {
      server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const chunk = 'z'.repeat(8192);
        if (req.url === '/ignore') {
          for (let i = 0; i < 1000; i++) res.write(chunk);
          res.end();
          return;
        }
        void (async () => {
          for (let i = 0; i < 1000; i++) {
            if (!res.write(chunk)) await once(res, 'drain');
          }
          res.end();
        })();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      server.closeAllConnections();
      server.close();
      await delay(0);
    });

    const request = (path: string) => ({ method: 'GET' as const, path, headers: {}, body: null });

    it('detects a handler that ignores res.write() backpressure', async () => {
      const outcome = await slowRead(baseUrl, request('/ignore'), {
        holdMs: 200,
        timeoutMs: 10_000,
      });
      expect(outcome).toMatchObject({ kind: 'completed', status: 200 });
      expect(outcome.bytes).toBeGreaterThan(8_000_000);

      const report = tracker.report();
      expect(report.ignoredWrites).toBeGreaterThan(100);
      const [site] = report.sites;
      expect(site?.streamType).toBe('ServerResponse');
      expect(site?.location?.file).toBe(THIS_FILE);
      // Socket-level writes made by Node's http internals are not blamed on the app.
      expect(report.sites.every((entry) => entry.streamType === 'ServerResponse')).toBe(true);
    });

    it('accepts a handler that waits for drain', async () => {
      const outcome = await slowRead(baseUrl, request('/respect'), {
        holdMs: 200,
        timeoutMs: 10_000,
      });
      expect(outcome).toMatchObject({ kind: 'completed', status: 200 });
      const report = tracker.report();
      expect(report.backpressureSignals).toBeGreaterThan(0);
      expect(report.ignoredWrites).toBe(0);
    });
  });
});

describe('evaluateBackpressure', () => {
  const base: BackpressureMetrics = {
    request: 'GET /export',
    requests: 1,
    holdMs: 1000,
    maxIgnoredWrites: 0,
    backpressureSignals: 12,
    ignoredWrites: 0,
    ignoredInternalWrites: 0,
    episodes: 0,
    sites: [],
    clients: [{ outcome: 'completed', status: 200, bytes: 1000 }],
  };

  it('fails and points at the source when writes were ignored', () => {
    const verdict = evaluateBackpressure({
      ...base,
      ignoredWrites: 143,
      episodes: 1,
      sites: [
        {
          location: 'src/exportUsers.ts:84',
          attribution: 'application',
          streamType: 'ServerResponse',
          ignoredWrites: 143,
          episodes: 1,
          stack: [],
        },
      ],
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toBe('143 writes after write() returned false');
    expect(verdict.details).toEqual([
      'Writable stream (ServerResponse) ignored backpressure.',
      "write() returned false, then 143 more writes happened before 'drain'.",
      'Source: src/exportUsers.ts:84',
    ]);
  });

  it('uses cautious wording when no application frame was found', () => {
    const verdict = evaluateBackpressure({
      ...base,
      ignoredWrites: 5,
      sites: [
        {
          location: 'node_modules/lib/index.js:10',
          attribution: 'dependency',
          streamType: 'Gzip',
          ignoredWrites: 5,
          episodes: 1,
          stack: [],
        },
      ],
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.details[0]).toBe('Possible backpressure violation inside a dependency (Gzip).');
  });

  it('passes within the allowed number of ignored writes', () => {
    expect(evaluateBackpressure({ ...base, ignoredWrites: 2, maxIgnoredWrites: 5 }).status).toBe(
      'pass',
    );
  });

  it('warns when the scenario never produced backpressure', () => {
    const verdict = evaluateBackpressure({ ...base, backpressureSignals: 0 });
    expect(verdict.status).toBe('warn');
    expect(verdict.summary).toBe('backpressure was never triggered');
  });

  it('errors when the slow client never got a response', () => {
    const verdict = evaluateBackpressure({
      ...base,
      backpressureSignals: 0,
      clients: [{ outcome: 'refused', status: null, bytes: 0 }],
    });
    expect(verdict.status).toBe('error');
  });

  it('shortens stack frames relative to the project root', () => {
    const metrics = toBackpressureMetrics(
      {
        installed: true,
        backpressureSignals: 1,
        ignoredWrites: 3,
        ignoredInternalWrites: 0,
        episodes: 1,
        overflowWrites: 0,
        sites: [
          {
            attribution: 'application',
            location: { fn: 'exportUsers', file: '/app/src/export.js', line: 12, column: 5 },
            frames: [{ fn: 'exportUsers', file: '/app/src/export.js', line: 12, column: 5 }],
            streamType: 'ServerResponse',
            ignoredWrites: 3,
            episodes: 1,
          },
        ],
      },
      [],
      {
        enabled: true,
        request: { method: 'GET', path: '/export', headers: {}, body: null },
        requests: 1,
        holdMs: 1000,
        maxIgnoredWrites: 0,
        timeoutMs: 1000,
      },
      '/app',
    );
    expect(metrics.sites[0]?.location).toBe('src/export.js:12');
    expect(metrics.sites[0]?.stack).toEqual(['exportUsers (src/export.js:12)']);
  });
});
