import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'apps/relay/test/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'], testTimeout: 20000 } });
