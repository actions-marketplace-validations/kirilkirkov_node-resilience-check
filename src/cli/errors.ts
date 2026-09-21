import { ConfigNotFoundError, displayPath } from '../config/load.js';
import { ConfigError } from '../config/validate.js';
import type { Style } from '../reporter/style.js';

/** Friendly rendering for configuration problems: one sentence per issue. */
export function renderConfigProblem(style: Style, error: unknown): string | null {
  if (error instanceof ConfigNotFoundError) {
    return `${style.red('✗')} ${error.message}\n`;
  }
  if (error instanceof ConfigError) {
    const where = error.file ? ` (${displayPath(error.file)})` : '';
    const lines = [`${style.red('✗')} ${style.bold(`Invalid configuration${where}:`)}`, ''];
    for (const issue of error.issues) lines.push(`    ${issue}`);
    lines.push('', style.dim('    Configuration reference: docs/configuration.md'));
    return `${lines.join('\n')}\n`;
  }
  return null;
}
