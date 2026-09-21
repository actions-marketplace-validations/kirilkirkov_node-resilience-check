import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Integration tests run the real CLI, so they need a fresh build. */
export default function setup(): void {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  rmSync(new URL('../../dist', import.meta.url), { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  });
}
