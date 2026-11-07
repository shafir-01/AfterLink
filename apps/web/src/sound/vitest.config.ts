import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../../../..', import.meta.url)),
  test: { include: ['apps/web/src/sound/**/*.test.ts'], testTimeout: 20000 },
});
