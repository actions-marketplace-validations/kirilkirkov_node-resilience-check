/**
 * A tiny validation toolkit that produces one readable sentence per problem,
 * e.g. "checks.eventLoop.maxP99Ms must be greater than 0." Invalid values are
 * replaced by placeholders so validation can continue and report every issue
 * at once; callers must discard the result when any issue was recorded.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function joinPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return parent === '' ? key : `${parent}.${key}`;
}

interface NumberRule {
  default?: number;
  integer?: boolean;
  /** Value must be strictly greater than this. */
  greaterThan?: number;
  min?: number;
  max?: number;
}

export class ObjectReader {
  private readonly seen = new Set<string>();

  private constructor(
    readonly path: string,
    private readonly value: Record<string, unknown>,
    readonly issues: string[],
  ) {}

  static from(value: unknown, path: string, issues: string[]): ObjectReader | null {
    if (!isPlainObject(value)) {
      issues.push(`${path || 'The configuration'} must be an object.`);
      return null;
    }
    return new ObjectReader(path, value, issues);
  }

  pathOf(key: string): string {
    return joinPath(this.path, key);
  }

  has(key: string): boolean {
    return this.value[key] !== undefined;
  }

  raw(key: string): unknown {
    this.seen.add(key);
    return this.value[key];
  }

  issue(key: string, message: string): void {
    this.issues.push(`${this.pathOf(key)} ${message}`);
  }

  requiredString(key: string): string {
    const value = this.raw(key);
    if (value === undefined) {
      this.issue(key, 'is required.');
      return '';
    }
    if (typeof value !== 'string' || value.trim() === '') {
      this.issue(key, 'must be a non-empty string.');
      return '';
    }
    return value;
  }

  optionalString(key: string): string | null {
    const value = this.raw(key);
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.trim() === '') {
      this.issue(key, 'must be a non-empty string.');
      return null;
    }
    return value;
  }

  number(key: string, rule: NumberRule): number {
    const value = this.raw(key);
    const fallback = rule.default ?? 0;
    if (value === undefined) {
      if (rule.default === undefined) this.issue(key, 'is required.');
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.issue(key, 'must be a number.');
      return fallback;
    }
    if (rule.integer && !Number.isInteger(value)) {
      this.issue(key, 'must be a whole number.');
      return fallback;
    }
    if (rule.greaterThan !== undefined && value <= rule.greaterThan) {
      this.issue(key, `must be greater than ${rule.greaterThan}.`);
      return fallback;
    }
    if (rule.min !== undefined && value < rule.min) {
      this.issue(key, `must be at least ${rule.min}.`);
      return fallback;
    }
    if (rule.max !== undefined && value > rule.max) {
      this.issue(key, `must be at most ${rule.max}.`);
      return fallback;
    }
    return value;
  }

  optionalNumber(key: string, rule: Omit<NumberRule, 'default'>): number | null {
    // Mark the key as known even when absent so typos can be matched to it.
    this.seen.add(key);
    return this.has(key) ? this.number(key, rule) : null;
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      this.issue(key, 'must be true or false.');
      return fallback;
    }
    return value;
  }

  oneOf<T extends string>(
    key: string,
    options: readonly T[],
    fallback: T,
    normalize: (value: string) => string = (value) => value,
  ): T {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    const normalized = typeof value === 'string' ? normalize(value) : value;
    if (typeof normalized !== 'string' || !(options as readonly string[]).includes(normalized)) {
      this.issue(key, `must be one of: ${options.join(', ')}.`);
      return fallback;
    }
    return normalized as T;
  }

  object(key: string, options: { required: boolean }): ObjectReader | null {
    const value = this.raw(key);
    if (value === undefined) {
      if (options.required) this.issue(key, 'is required.');
      return null;
    }
    return ObjectReader.from(value, this.pathOf(key), this.issues);
  }

  stringRecord(key: string): Record<string, string> {
    const value = this.raw(key);
    if (value === undefined) return {};
    if (!isPlainObject(value)) {
      this.issue(key, 'must be an object of string values.');
      return {};
    }
    const result: Record<string, string> = {};
    for (const [name, entry] of Object.entries(value)) {
      if (typeof entry !== 'string') {
        this.issues.push(`${joinPath(this.pathOf(key), name)} must be a string.`);
        continue;
      }
      result[name] = entry;
    }
    return result;
  }

  /** Reports keys that were never read, suggesting the closest known key. */
  finish(): void {
    for (const key of Object.keys(this.value)) {
      if (this.seen.has(key)) continue;
      const suggestion = closest(key, [...this.seen]);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
      this.issues.push(`${this.pathOf(key)} is not a known option.${hint}`);
    }
  }
}

function closest(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(input.length / 4)) ? best : null;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
