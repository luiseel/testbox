import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@testbox/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
