import { Command, InvalidArgumentError } from 'commander';
import type { CheckId } from '../checks/types.js';
import { DEFAULT_CONFIG_FILE } from '../config/load.js';
import { CHECK_IDS } from '../runner/plan.js';
import { MAX_SEED } from '../shared/random.js';
import { TAGLINE, VERSION } from '../version.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { verifyCommand } from './commands/verify.js';

export function parseSeed(value: string): number {
  const seed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(seed) || seed > MAX_SEED) {
    throw new InvalidArgumentError(`must be a whole number between 0 and ${MAX_SEED}.`);
  }
  return seed;
}

export function parseOnly(value: string): CheckId[] {
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !(CHECK_IDS as readonly string[]).includes(id));
  if (ids.length === 0 || unknown.length > 0) {
    throw new InvalidArgumentError(`use a comma-separated list of: ${CHECK_IDS.join(', ')}.`);
  }
  return ids as CheckId[];
}

/** Commands resolve to an exit code; the entry point applies it. */
export function createProgram(setExitCode: (code: number) => void): Command {
  const program = new Command()
    .name('resilience-check')
    .description(
      `${TAGLINE}\n\nResilience testing for Node.js services: event-loop blocking, backpressure,\n` +
        'retry storms, concurrency invariants and graceful shutdown.',
    )
    .version(VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .showHelpAfterError('(run with --help for usage)')
    // Must be set before subcommands are added so they inherit it.
    .exitOverride();

  program
    .command('init')
    .description(`create ${DEFAULT_CONFIG_FILE} in the current directory`)
    .option('-c, --config <path>', 'where to write the file', DEFAULT_CONFIG_FILE)
    .option('-f, --force', 'overwrite an existing file')
    .option('--no-color', 'disable colored output')
    .action(async (options: { config: string; force?: boolean; color: boolean }) => {
      setExitCode(await initCommand(options));
    });

  program
    .command('verify')
    .description('start the service, run the enabled checks and report problems')
    .option('-c, --config <path>', 'path to the configuration file', DEFAULT_CONFIG_FILE)
    .option(
      '-s, --seed <number>',
      'seed for randomized scheduling (printed on every run)',
      parseSeed,
    )
    .option('--json <path>', 'also write a machine-readable JSON report')
    .option('--only <checks>', `run a subset of checks (${CHECK_IDS.join(', ')})`, parseOnly)
    .option('--verbose', 'stream the service output to stderr')
    .option('--no-color', 'disable colored output')
    .addHelpText(
      'after',
      '\nExit codes:\n  0  all enabled checks passed (warnings allowed)\n' +
        '  1  at least one check failed or could not produce a result\n' +
        '  2  configuration or startup problem; no checks were run\n' +
        '  130  interrupted',
    )
    .action(async (options: Parameters<typeof verifyCommand>[0]) => {
      setExitCode(await verifyCommand(options));
    });

  program
    .command('doctor')
    .description('check the environment and configuration without running the checks')
    .option('-c, --config <path>', 'path to the configuration file', DEFAULT_CONFIG_FILE)
    .option('--no-color', 'disable colored output')
    .action(async (options: { config: string; color: boolean }) => {
      setExitCode(await doctorCommand(options));
    });

  return program;
}
