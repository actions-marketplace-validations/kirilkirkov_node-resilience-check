/**
 * Heuristics over the timestamps of downstream attempts seen by the fault
 * proxy. The proxy cannot tell which attempt belongs to which incoming
 * request, so everything here is inferred from aggregate timing and is
 * phrased as an observation, never as proof.
 */
import { round } from '../shared/time.js';

const DEFAULT_BURST_WINDOW_MS = 20;
const MIN_RETRIES_FOR_ANALYSIS = 3;
const SYNCHRONIZED_SHARE_THRESHOLD = 0.5;
const INCREASING_RATIO = 1.5;
const CONSTANT_RATIO = 1.25;

export type JitterAssessment = 'not-applicable' | 'insufficient-data' | 'absent' | 'present';

export type BackoffAssessment =
  | 'not-applicable'
  | 'insufficient-data'
  | 'undetermined'
  | 'immediate'
  | 'constant'
  | 'increasing'
  | 'inconclusive';

export interface RetryWave {
  startMs: number;
  size: number;
  spanMs: number;
}

export interface RetryTimingInput {
  /** Attempt times in ms relative to the start of the scenario, any order. */
  attemptsMs: number[];
  incomingRequests: number;
  /** Maximum number of incoming requests in flight at once. */
  concurrency: number;
  burstWindowMs?: number;
}

export interface RetryTimingAnalysis {
  attempts: number;
  incomingRequests: number;
  retries: number;
  amplification: number;
  burstWindowMs: number;
  minBurstSize: number;
  /** Share (0..1) of retries that arrived inside a tight burst. */
  synchronizedShare: number | null;
  jitter: JitterAssessment;
  waves: RetryWave[];
  waveIntervalsMs: number[];
  backoff: BackoffAssessment;
  notes: string[];
}

export function retryAmplification(attempts: number, incomingRequests: number): number {
  return incomingRequests > 0 ? attempts / incomingRequests : 0;
}

/**
 * Counts values that belong to at least one window of `windowMs` holding
 * `minSize` or more values. `sorted` must be ascending.
 */
export function countInBursts(sorted: number[], windowMs: number, minSize: number): number {
  const coverage = new Array<number>(sorted.length + 1).fill(0);
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) > windowMs) start++;
    if (end - start + 1 >= minSize) {
      coverage[start] = (coverage[start] ?? 0) + 1;
      coverage[end + 1] = (coverage[end + 1] ?? 0) - 1;
    }
  }
  let running = 0;
  let covered = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += coverage[i] ?? 0;
    if (running > 0) covered++;
  }
  return covered;
}

/** Groups ascending timestamps; a gap larger than `gapMs` starts a new wave. */
export function groupIntoWaves(sorted: number[], gapMs: number): RetryWave[] {
  const waves: RetryWave[] = [];
  let current: { first: number; last: number; size: number } | null = null;
  const close = (wave: { first: number; last: number; size: number }): void => {
    waves.push({ startMs: wave.first, size: wave.size, spanMs: wave.last - wave.first });
  };
  for (const time of sorted) {
    if (current && time - current.last <= gapMs) {
      current.last = time;
      current.size++;
      continue;
    }
    if (current) close(current);
    current = { first: time, last: time, size: 1 };
  }
  if (current) close(current);
  return waves;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function assessBackoff(
  sorted: number[],
  burstWindowMs: number,
  minBurstSize: number,
): Pick<RetryTimingAnalysis, 'waves' | 'waveIntervalsMs' | 'backoff'> & { note: string } {
  const waves = groupIntoWaves(sorted, burstWindowMs).filter((wave) => wave.size >= minBurstSize);
  const intervals = waves.slice(1).map((wave, i) => round(wave.startMs - (waves[i]?.startMs ?? 0)));
  const total = sorted.length;
  const onlyWave = waves.length === 1 ? waves[0] : undefined;

  if (onlyWave && onlyWave.size >= 0.8 * total) {
    return {
      waves,
      waveIntervalsMs: intervals,
      backoff: 'immediate',
      note: `Retries appear to happen with little or no delay: ${onlyWave.size} attempts arrived within ${round(onlyWave.spanMs)}ms.`,
    };
  }
  if (intervals.length < 2) {
    return {
      waves,
      waveIntervalsMs: intervals,
      backoff: 'insufficient-data',
      note: 'Not enough distinct retry waves to judge backoff.',
    };
  }
  const ratios = intervals.slice(1).map((interval, i) => interval / Math.max(intervals[i] ?? 1, 1));
  const growth = median(ratios);
  if (growth >= INCREASING_RATIO) {
    return {
      waves,
      waveIntervalsMs: intervals,
      backoff: 'increasing',
      note: `Intervals between retry waves grew (${intervals.join(' → ')}ms), consistent with exponential backoff.`,
    };
  }
  if (growth <= CONSTANT_RATIO) {
    return {
      waves,
      waveIntervalsMs: intervals,
      backoff: 'constant',
      note: `Retry waves arrived at steady ~${round(median(intervals))}ms intervals; no exponential backoff was observed.`,
    };
  }
  return {
    waves,
    waveIntervalsMs: intervals,
    backoff: 'inconclusive',
    note: `Retry wave intervals (${intervals.join(', ')}ms) show no clear backoff pattern.`,
  };
}

export function analyzeRetryTiming(input: RetryTimingInput): RetryTimingAnalysis {
  const burstWindowMs = input.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;
  const sorted = [...input.attemptsMs].sort((a, b) => a - b);
  const attempts = sorted.length;
  const retries = Math.max(0, attempts - input.incomingRequests);
  const parallel = Math.min(input.incomingRequests, input.concurrency);
  const minBurstSize = Math.max(3, Math.ceil(parallel / 2));

  const base = {
    attempts,
    incomingRequests: input.incomingRequests,
    retries,
    amplification: retryAmplification(attempts, input.incomingRequests),
    burstWindowMs,
    minBurstSize,
  };

  if (retries === 0) {
    return {
      ...base,
      synchronizedShare: null,
      jitter: 'not-applicable',
      waves: [],
      waveIntervalsMs: [],
      backoff: 'not-applicable',
      notes: ['No retries were observed.'],
    };
  }
  if (retries < MIN_RETRIES_FOR_ANALYSIS || parallel < 3) {
    return {
      ...base,
      synchronizedShare: null,
      jitter: 'insufficient-data',
      waves: [],
      waveIntervalsMs: [],
      backoff: 'insufficient-data',
      notes: ['Too few retries or concurrent requests to judge retry timing.'],
    };
  }

  // Treat the earliest `incomingRequests` attempts as first tries; the rest
  // are retries. With concurrency below the request count this is only an
  // approximation, which is why the result is a heuristic.
  const retryTimes = sorted.slice(input.incomingRequests);
  const synchronizedShare = countInBursts(retryTimes, burstWindowMs, minBurstSize) / retries;
  const percent = Math.round(synchronizedShare * 100);

  if (synchronizedShare < SYNCHRONIZED_SHARE_THRESHOLD) {
    return {
      ...base,
      synchronizedShare,
      jitter: 'present',
      waves: [],
      waveIntervalsMs: [],
      backoff: 'undetermined',
      notes: [
        `Retries were spread out over time (only ${percent}% arrived in tight bursts), which is consistent with jitter.`,
      ],
    };
  }

  const { note, ...backoff } = assessBackoff(sorted, burstWindowMs, minBurstSize);
  return {
    ...base,
    synchronizedShare,
    jitter: 'absent',
    ...backoff,
    notes: [
      `${percent}% of retries arrived in tight bursts (${minBurstSize}+ attempts within ${burstWindowMs}ms). No meaningful jitter was observed.`,
      note,
    ],
  };
}
