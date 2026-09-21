import { randomInt } from 'node:crypto';

export const MAX_SEED = 2 ** 32 - 1;

export interface Random {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
}

/**
 * mulberry32 — tiny and fast. It only drives scheduling jitter, so
 * reproducibility matters here, not cryptographic quality.
 */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
  };
}

/**
 * Derives an independent stream per scenario so that adding or reordering
 * scenarios does not change the schedule of the others for the same seed.
 */
export function deriveSeed(seed: number, label: string): number {
  // FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (seed ^ hash) >>> 0;
}

/** Six-digit seeds are easy to read aloud and paste into `--seed`. */
export function generateSeed(): number {
  return randomInt(100_000, 1_000_000);
}
