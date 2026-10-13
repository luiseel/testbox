import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@testbox/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      '@testbox/worker': path.resolve(__dirname, '../worker/src/index.ts'),
    },
  },
});
