/**
 * Resolves true if `promise` settles within `ms`, false otherwise. Unlike
 * `Promise.race` with a sleep, it never leaves a pending timer behind that
 * would keep the process alive.
 */
export function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
