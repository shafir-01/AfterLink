import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../../../..', import.meta.url)),
  test: { include: ['apps/relay/src/voice/**/*.test.ts', 'apps/web/src/voice/**/*.test.ts'], testTimeout: 20000 },
});
