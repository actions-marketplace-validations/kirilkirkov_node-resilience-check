import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface PackageJson {
  main?: unknown;
  scripts?: Record<string, unknown>;
}

/** Best guess at how the project starts its service, based on package.json. */
export async function detectStartCommand(cwd: string): Promise<string> {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return 'node index.js';
  }
  if (typeof pkg.scripts?.start === 'string') {
    if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm start';
    if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn start';
    return 'npm start';
  }
  if (typeof pkg.main === 'string') return `node ${pkg.main}`;
  return 'node index.js';
}

/**
 * The generated file enables the two checks that work for any HTTP service
 * and includes disabled, ready-to-edit examples of the others. JSON has no
 * comments, so every option is documented in docs/configuration.md.
 */
export function createConfigTemplate(command: string): Record<string, unknown> {
  return {
    service: {
      command,
      baseUrl: 'http://127.0.0.1:3000',
      healthPath: '/health',
      startupTimeoutMs: 10000,
    },
    checks: {
      eventLoop: {
        enabled: true,
        path: '/health',
        requests: 50,
        concurrency: 10,
        maxP99Ms: 100,
      },
      gracefulShutdown: {
        enabled: true,
        path: '/health',
        concurrency: 10,
        signalAfterMs: 100,
        shutdownTimeoutMs: 5000,
        maxDroppedRequests: 0,
      },
      backpressure: {
        enabled: false,
        path: '/export',
        holdMs: 1000,
        maxIgnoredWrites: 0,
      },
      retryStorm: {
        enabled: false,
        dependency: { env: 'PAYMENTS_URL', target: 'http://127.0.0.1:4001' },
        trigger: { method: 'POST', path: '/checkout', requests: 20, concurrency: 20 },
        fault: { type: 'status', status: 503, durationMs: 3000 },
        maxAmplification: 3,
      },
      concurrency: [
        {
          name: 'reserve-stock',
          enabled: false,
          request: { method: 'POST', path: '/products/1/reserve', body: { quantity: 1 } },
          requests: 10,
          assert: { status: 200, maxSuccesses: 1 },
        },
      ],
    },
  };
}
