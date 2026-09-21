#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createProgram } from './program.js';

// When output is piped into something that exits early (e.g. `| head`),
// keep running so the service is still cleaned up normally.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error;
});

const program = createProgram((code) => {
  process.exitCode = code;
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // --help and --version exit with 0; usage errors are configuration problems.
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    process.stderr.write(
      `resilience-check: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
