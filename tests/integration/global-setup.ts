import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Integration tests run the real CLI and the bundled Action, so they need a fresh build. */
export default function setup(): void {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, ['scripts/clean.mjs'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['scripts/build-action.mjs'], { cwd: root, stdio: 'inherit' });
}
