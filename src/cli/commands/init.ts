import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { displayPath, resolveConfigPath } from '../../config/load.js';
import { createConfigTemplate, detectStartCommand } from '../../config/template.js';
import { createStyle, shouldUseColor } from '../../reporter/style.js';

export interface InitCommandOptions {
  config: string;
  force?: boolean;
  color: boolean;
}

const CONFIG_DOCS =
  'https://github.com/kirilkirkov/node-resilience-check/blob/main/docs/configuration.md';

export async function initCommand(options: InitCommandOptions): Promise<number> {
  const style = createStyle(shouldUseColor(process.stdout, process.env, options.color));
  const file = resolveConfigPath(options.config);
  const shown = displayPath(file);

  if (existsSync(file) && !options.force) {
    process.stderr.write(
      `${style.red('✗')} ${shown} already exists. Use --force to overwrite it.\n`,
    );
    return 2;
  }

  const command = await detectStartCommand(process.cwd());
  await writeFile(file, `${JSON.stringify(createConfigTemplate(command), null, 2)}\n`, 'utf8');

  process.stdout.write(
    [
      `${style.green('✓')} Created ${shown}`,
      '',
      `  service.command   ${command}`,
      '  service.baseUrl   http://127.0.0.1:3000',
      '',
      'Next steps:',
      '  1. Check service.command, service.baseUrl and service.healthPath.',
      '  2. Point each check at a real endpoint and enable the ones you need.',
      '  3. Run: npx resilience-check verify',
      '',
      style.dim(`Every option is documented at ${CONFIG_DOCS}`),
      '',
    ].join('\n'),
  );
  return 0;
}
