export interface Style {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

/**
 * Colour only when writing to a terminal, honouring NO_COLOR
 * (https://no-color.org), FORCE_COLOR and an explicit --no-color flag.
 */
export function shouldUseColor(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  flag = true,
): boolean {
  if (!flag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

const wrap =
  (enabled: boolean, open: number, close: number) =>
  (text: string): string =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export function createStyle(enabled: boolean): Style {
  return {
    enabled,
    bold: wrap(enabled, 1, 22),
    dim: wrap(enabled, 2, 22),
    red: wrap(enabled, 31, 39),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    cyan: wrap(enabled, 36, 39),
  };
}
