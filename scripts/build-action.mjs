// Bundles the GitHub Action into dist/action/, which is committed so that
// `uses: kirilkirkov/node-resilience-check@<tag>` works without an install.
//
//   dist/action/index.js      the Action (runs on GitHub's node24 runtime)
//   dist/action/agent.js      the preload injected into the user's service
//   dist/action/package.json  marks both files as ES modules
//
// Nothing outside dist/action/ is read at runtime.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = fileURLToPath(new URL('../dist/action/', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await rm(outdir, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/action/index.ts', agent: 'src/agent/index.ts' },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // The agent runs inside the user's service, which may be on Node.js 22.
  target: 'node22.12',
  // Keeps the output deterministic so CI can detect a stale bundle.
  splitting: false,
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    BUNDLED_MANIFEST: JSON.stringify({ name: manifest.name, version: manifest.version }),
  },
  // Lets bundled CommonJS dependencies call require() for Node.js built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
await writeFile(new URL('package.json', `file://${outdir}`), '{ "type": "module" }\n');
