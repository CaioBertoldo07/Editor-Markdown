import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Os testes de integração compilam documentos reais: um arquivo por vez.
    fileParallelism: false,
    testTimeout: 120_000,
    env: { NODE_ENV: 'test' },
  },
});
