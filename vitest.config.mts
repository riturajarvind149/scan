import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Run against source so `npm test` works on a fresh clone with nothing built.
    alias: {
      '@qr2win/shared-types': path.resolve(import.meta.dirname, 'packages/shared-types/src/index.ts'),
      '@qr2win/relay-core': path.resolve(import.meta.dirname, 'packages/relay-core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    testTimeout: 15000,
  },
});
