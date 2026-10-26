import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Um único banco de teste compartilhado: arquivos rodam em sequência.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test' },
  },
});
