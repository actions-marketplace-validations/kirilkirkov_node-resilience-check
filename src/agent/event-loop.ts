import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from 'node:perf_hooks';
import type { EventLoopSnapshot } from '../shared/protocol.js';

export interface EventLoopProbe {
  start(resolutionMs: number): void;
  stop(): EventLoopSnapshot;
}

/**
 * The histogram only exists between start() and stop(), so a service that
 * never runs the event-loop check pays nothing for it.
 */
export function createEventLoopProbe(): EventLoopProbe {
  let histogram: IntervalHistogram | null = null;
  let utilizationStart: EventLoopUtilization | null = null;
  let startedAt = 0;

  return {
    start(resolutionMs) {
      histogram?.disable();
      histogram = monitorEventLoopDelay({ resolution: resolutionMs });
      histogram.enable();
      utilizationStart = performance.eventLoopUtilization();
      startedAt = performance.now();
    },

    stop() {
      if (!histogram || !utilizationStart) {
        throw new Error('Event loop measurement was not started.');
      }
      histogram.disable();
      const snapshot = snapshotHistogram(
        histogram,
        performance.eventLoopUtilization(utilizationStart).utilization,
        performance.now() - startedAt,
      );
      histogram = null;
      utilizationStart = null;
      return snapshot;
    },
  };
}

function snapshotHistogram(
  histogram: IntervalHistogram,
  utilization: number,
  windowMs: number,
): EventLoopSnapshot {
  const samples = histogram.count;
  if (samples === 0) {
    // With no samples, min is Int64 max and mean is NaN; report zeros instead.
    return {
      samples,
      minNs: 0,
      maxNs: 0,
      meanNs: 0,
      stddevNs: 0,
      p50Ns: 0,
      p95Ns: 0,
      p99Ns: 0,
      utilization,
      windowMs,
    };
  }
  return {
    samples,
    minNs: histogram.min,
    maxNs: histogram.max,
    meanNs: finiteOrZero(histogram.mean),
    stddevNs: finiteOrZero(histogram.stddev),
    p50Ns: histogram.percentile(50),
    p95Ns: histogram.percentile(95),
    p99Ns: histogram.percentile(99),
    utilization,
    windowMs,
  };
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
