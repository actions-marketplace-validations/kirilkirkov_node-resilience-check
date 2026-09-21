import { OutgoingMessage } from 'node:http';
import { Duplex, Writable } from 'node:stream';
import type { BackpressureReport, BackpressureSite } from '../shared/protocol.js';
import { classifyFrame, parseStack, type StackFrame } from '../shared/stack.js';

type WriteFn = (this: unknown, ...args: unknown[]) => unknown;

interface WritableLike {
  readonly writableNeedDrain?: boolean;
}

interface Site extends BackpressureSite {
  key: string;
}

interface Episode {
  generation: number;
  /** `internal` when Node.js core itself is the caller of write(). */
  kind: 'internal' | 'attributed';
  /** null for internal episodes, or when the site table is full. */
  site: Site | null;
}

interface StreamState {
  waiting: boolean;
  episode: Episode | null;
}

export interface BackpressureTrackerOptions {
  /** Frames under this directory belong to ResilienceCheck and are skipped. */
  selfDir?: string | null;
  maxSites?: number;
  stackDepth?: number;
}

export interface BackpressureTracker {
  wrap(original: WriteFn): WriteFn;
  report(): BackpressureReport;
  reset(): void;
}

interface Counters {
  backpressureSignals: number;
  ignoredWrites: number;
  ignoredInternalWrites: number;
  episodes: number;
  overflowWrites: number;
}

const emptyCounters = (): Counters => ({
  backpressureSignals: 0,
  ignoredWrites: 0,
  ignoredInternalWrites: 0,
  episodes: 0,
  overflowWrites: 0,
});

/**
 * Detects the producer-side contract violation "write() returned false, but
 * more write() calls followed before 'drain'".
 *
 * The wrapped write() never changes arguments, return values or thrown
 * errors. Instead of adding 'drain' listeners it reads `writableNeedDrain`,
 * which Node resets exactly when 'drain' is emitted, so no listener can leak
 * and no MaxListeners warning can be triggered.
 */
export function createBackpressureTracker(
  options: BackpressureTrackerOptions = {},
): BackpressureTracker {
  const selfDir = options.selfDir ?? null;
  const maxSites = options.maxSites ?? 20;
  const stackDepth = options.stackDepth ?? 30;

  // WeakMap: tracking state must never keep a finished stream alive.
  const streams = new WeakMap<object, StreamState>();
  let sites = new Map<string, Site>();
  let counters = emptyCounters();
  // Bumped by reset() so episodes that started earlier are re-attributed.
  let generation = 0;

  function captureFrames(boundary: WriteFn): StackFrame[] {
    const holder: { stack?: string } = {};
    const previousLimit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = stackDepth;
      // Frames above and including the wrapper are omitted, so frame 0 is
      // whoever called write().
      Error.captureStackTrace(holder, boundary);
      return parseStack(holder.stack ?? '');
    } catch {
      return [];
    } finally {
      Error.stackTraceLimit = previousLimit;
    }
  }

  function siteFor(frames: StackFrame[], stream: object): Site | null {
    const visible = frames.filter((frame) => {
      const origin = classifyFrame(frame, selfDir);
      return origin === 'application' || origin === 'dependency';
    });
    const appFrame = visible.find((frame) => classifyFrame(frame, selfDir) === 'application');
    const location = appFrame ?? visible[0] ?? null;
    const streamType = stream.constructor?.name || 'Writable';
    const key = location
      ? `${streamType}|${location.file}:${location.line}:${location.column}`
      : `${streamType}|unknown`;

    const existing = sites.get(key);
    if (existing) return existing;
    if (sites.size >= maxSites) return null;

    const site: Site = {
      key,
      attribution: appFrame ? 'application' : 'dependency',
      location,
      frames: visible.slice(0, 8),
      streamType,
      ignoredWrites: 0,
      episodes: 0,
    };
    sites.set(key, site);
    return site;
  }

  function startEpisode(stream: object, boundary: WriteFn): Episode {
    const frames = captureFrames(boundary);
    const caller = frames[0];
    // Node's own code sometimes flushes an already-buffered queue in one go
    // (e.g. http's _flushOutput). That is not a producer ignoring the
    // contract, so only writes whose direct caller is user or dependency
    // code are attributed.
    const callerOrigin = caller ? classifyFrame(caller, selfDir) : 'internal';
    if (callerOrigin === 'internal' || callerOrigin === 'self') {
      return { generation, kind: 'internal', site: null };
    }
    counters.episodes++;
    const site = siteFor(frames, stream);
    if (site) site.episodes++;
    return { generation, kind: 'attributed', site };
  }

  function recordIgnoredWrite(stream: object, state: StreamState, boundary: WriteFn): void {
    // Stack capture is the expensive part, so it happens once per episode;
    // later writes in the same episode come from the same producer loop.
    if (!state.episode || state.episode.generation !== generation) {
      state.episode = startEpisode(stream, boundary);
    }
    const { episode } = state;
    if (episode.kind === 'internal') {
      counters.ignoredInternalWrites++;
      return;
    }
    counters.ignoredWrites++;
    if (episode.site) episode.site.ignoredWrites++;
    else counters.overflowWrites++;
  }

  function wrap(original: WriteFn): WriteFn {
    const patched: WriteFn = function (this: unknown, ...args: unknown[]): unknown {
      // write() called on a non-object is left for the original to reject.
      const stream = typeof this === 'object' && this !== null ? this : null;
      const state = stream ? streams.get(stream) : undefined;

      if (stream && state?.waiting) {
        if ((stream as WritableLike).writableNeedDrain === true) {
          recordIgnoredWrite(stream, state, patched);
        } else {
          // 'drain' fired (or the stream ended) since the last false return.
          state.waiting = false;
          state.episode = null;
        }
      }

      const result = Reflect.apply(original, this, args);

      if (result === false && stream) {
        counters.backpressureSignals++;
        if (state) {
          if (!state.waiting) {
            state.waiting = true;
            state.episode = null;
          }
        } else {
          streams.set(stream, { waiting: true, episode: null });
        }
      }
      return result;
    };
    Object.defineProperty(patched, 'name', { value: original.name });
    return patched;
  }

  function report(): BackpressureReport {
    const list: BackpressureSite[] = [...sites.values()]
      .filter((site) => site.ignoredWrites > 0)
      .sort((a, b) => b.ignoredWrites - a.ignoredWrites)
      .map(({ key: _key, ...site }) => ({ ...site, frames: [...site.frames] }));
    return { installed: true, ...counters, sites: list };
  }

  function reset(): void {
    sites = new Map();
    counters = emptyCounters();
    generation++;
  }

  return { wrap, report, reset };
}

interface PatchTarget {
  write: WriteFn;
}

/**
 * Patches write() on every prototype that owns one. Duplex.prototype.write is
 * a copy of Writable.prototype.write taken at module load, and
 * OutgoingMessage (http responses/requests) is not a Writable subclass at all,
 * so all three must be patched separately.
 */
export function installBackpressureTracking(tracker: BackpressureTracker): () => void {
  const prototypes = [
    Writable.prototype,
    Duplex.prototype,
    OutgoingMessage.prototype,
  ] as unknown as PatchTarget[];

  const restores: Array<() => void> = [];
  for (const proto of prototypes) {
    const original = proto.write;
    if (typeof original !== 'function') continue;
    const patched = tracker.wrap(original);
    proto.write = patched;
    restores.push(() => {
      if (proto.write === patched) proto.write = original;
    });
  }
  return () => {
    for (const restore of restores) restore();
  };
}
