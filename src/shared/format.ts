/** "3.2ms" below 10ms, "284ms" below a second, "1.2s" from there on. */
export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

export function formatRatio(value: number): string {
  return `${value.toFixed(2)}x`;
}
