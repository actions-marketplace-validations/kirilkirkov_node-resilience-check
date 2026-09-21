import { describe, expect, it } from 'vitest';
import {
  analyzeRetryTiming,
  countInBursts,
  groupIntoWaves,
  retryAmplification,
} from '../../src/analysis/retry-timing.js';
import { createRandom } from '../../src/shared/random.js';

/**
 * Simulates `clients` concurrent requests that each make `attempts` attempts,
 * with the delay before attempt n (1-based retry index) given by `delayFor`.
 */
function simulate(
  clients: number,
  attempts: number,
  delayFor: (retry: number, client: number) => number,
): number[] {
  const times: number[] = [];
  for (let client = 0; client < clients; client++) {
    // Concurrent first attempts arrive within a couple of milliseconds.
    let time = client * 0.1;
    times.push(time);
    for (let retry = 1; retry < attempts; retry++) {
      time += 1 + delayFor(retry, client); // ~1ms for the 503 round trip
      times.push(time);
    }
  }
  return times;
}

describe('retryAmplification', () => {
  it('divides downstream attempts by incoming requests', () => {
    expect(retryAmplification(137, 20)).toBeCloseTo(6.85);
    expect(retryAmplification(20, 20)).toBe(1);
    expect(retryAmplification(5, 0)).toBe(0);
  });
});

describe('countInBursts', () => {
  it('counts values inside dense windows only', () => {
    const sorted = [0, 1, 2, 3, 100, 200, 300, 301, 302];
    expect(countInBursts(sorted, 5, 3)).toBe(7);
    expect(countInBursts(sorted, 5, 4)).toBe(4);
    expect(countInBursts([], 5, 3)).toBe(0);
  });
});

describe('groupIntoWaves', () => {
  it('splits on gaps larger than the threshold', () => {
    expect(groupIntoWaves([0, 1, 2, 50, 51, 120], 20)).toEqual([
      { startMs: 0, size: 3, spanMs: 2 },
      { startMs: 50, size: 2, spanMs: 1 },
      { startMs: 120, size: 1, spanMs: 0 },
    ]);
    expect(groupIntoWaves([], 20)).toEqual([]);
  });
});

describe('analyzeRetryTiming', () => {
  it('reports no retries when every request made one attempt', () => {
    const analysis = analyzeRetryTiming({
      attemptsMs: simulate(20, 1, () => 0),
      incomingRequests: 20,
      concurrency: 20,
    });
    expect(analysis.retries).toBe(0);
    expect(analysis.amplification).toBe(1);
    expect(analysis.jitter).toBe('not-applicable');
    expect(analysis.backoff).toBe('not-applicable');
  });

  it('detects synchronized fixed-delay retries (no jitter, no backoff)', () => {
    const analysis = analyzeRetryTiming({
      attemptsMs: simulate(20, 6, () => 50),
      incomingRequests: 20,
      concurrency: 20,
    });
    expect(analysis.amplification).toBe(6);
    expect(analysis.jitter).toBe('absent');
    expect(analysis.synchronizedShare).toBe(1);
    expect(analysis.backoff).toBe('constant');
    expect(analysis.waves).toHaveLength(6);
    expect(analysis.notes[0]).toMatch(/No meaningful jitter/);
    expect(analysis.notes[1]).toMatch(/no exponential backoff/);
  });

  it('recognizes exponential backoff that still lacks jitter', () => {
    const analysis = analyzeRetryTiming({
      attemptsMs: simulate(20, 5, (retry) => 50 * 2 ** (retry - 1)),
      incomingRequests: 20,
      concurrency: 20,
    });
    expect(analysis.jitter).toBe('absent');
    expect(analysis.backoff).toBe('increasing');
    expect(analysis.waveIntervalsMs).toEqual([51, 101, 201, 401]);
  });

  it('recognizes immediate retries', () => {
    const analysis = analyzeRetryTiming({
      attemptsMs: simulate(10, 4, () => 0),
      incomingRequests: 10,
      concurrency: 10,
    });
    expect(analysis.jitter).toBe('absent');
    expect(analysis.backoff).toBe('immediate');
  });

  it('treats full-jitter exponential backoff as spread out', () => {
    const random = createRandom(42);
    const analysis = analyzeRetryTiming({
      attemptsMs: simulate(20, 3, (retry) => random.next() * 200 * 2 ** (retry - 1)),
      incomingRequests: 20,
      concurrency: 20,
    });
    expect(analysis.amplification).toBe(3);
    expect(analysis.jitter).toBe('present');
    expect(analysis.backoff).toBe('undetermined');
    expect(analysis.synchronizedShare).toBeLessThan(0.5);
  });

  it('refuses to judge timing from too little data', () => {
    const analysis = analyzeRetryTiming({
      attemptsMs: [0, 1, 60],
      incomingRequests: 2,
      concurrency: 2,
    });
    expect(analysis.retries).toBe(1);
    expect(analysis.jitter).toBe('insufficient-data');
    expect(analysis.backoff).toBe('insufficient-data');
  });

  it('is independent of the order attempts were recorded in', () => {
    const times = simulate(10, 4, () => 50);
    const shuffled = [...times].reverse();
    expect(
      analyzeRetryTiming({ attemptsMs: shuffled, incomingRequests: 10, concurrency: 10 }),
    ).toEqual(analyzeRetryTiming({ attemptsMs: times, incomingRequests: 10, concurrency: 10 }));
  });
});
