// Runs `resilience-check verify` against one of the examples. The broken
// example is supposed to exit with 1; this wrapper explains that instead of
// letting pnpm end the demo with a misleading "command failed" message.
import { spawn } from 'node:child_process';

const example = process.argv[2] ?? 'broken-service';
const expectedExitCode = example === 'broken-service' ? 1 : 0;

const child = spawn(
  process.execPath,
  [
    'dist/cli/index.js',
    'verify',
    '--config',
    `examples/${example}/resiliencecheck.config.json`,
    ...process.argv.slice(3),
  ],
  { stdio: 'inherit' },
);

// Ctrl+C reaches the CLI directly; wait for it to finish cleaning up.
process.on('SIGINT', () => {});

child.on('exit', (code) => {
  if (code === expectedExitCode) {
    console.log(`\nExit code ${code} — as expected for examples/${example}.`);
    process.exit(0);
  }
  process.exit(code ?? 1);
});
