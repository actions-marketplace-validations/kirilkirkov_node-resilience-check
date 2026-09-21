import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          testTimeout: 90_000,
          hookTimeout: 120_000,
          // The scenarios measure timing; running them side by side would
          // make them compete for CPU.
          fileParallelism: false,
        },
      },
    ],
  },
});
