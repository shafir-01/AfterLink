import type { Hono } from 'hono';
import { registerCompile } from './compile.js';
import { registerNarrate } from './narrate.js';
import { registerTriage } from './triage.js';
import type { AiContext } from './types.js';

export function register(app: Hono, ctx: AiContext): void {
  registerCompile(app, ctx);
  registerTriage(app, ctx);
  registerNarrate(app, ctx);
}

export type { AiContext } from './types.js';
