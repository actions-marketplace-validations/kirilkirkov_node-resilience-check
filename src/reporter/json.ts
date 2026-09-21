import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RunReport } from '../runner/report.js';

export async function writeJsonReport(path: string, report: RunReport): Promise<string> {
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}
