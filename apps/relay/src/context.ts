import { createHq, type Hq, type HubFactory, type HubLike } from './hq.ts';
import type { IngressTransport } from './ingress/service.ts';
import { limitsFromEnv, type Limits } from './limits.ts';

export interface RelayContext {
  env: NodeJS.ProcessEnv;
  limits: Limits;
  hq: Hq;
  /** Path from external requests to connected devices, backed by the signalling hub. */
  ingress: IngressTransport;
  /** Which live services have credentials configured. Booleans only. */
  services(): Record<string, boolean>;
  /** Names of sub-routers that registered. */
  routers: string[];
}

const SERVICE_ENV: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
  n8n: ['N8N_WEBHOOK_URL', 'N8N_INGRESS_SECRET'],
};

async function meshHub(): Promise<HubFactory | null> {
  try {
    const mod = (await import('@afterlink/mesh')) as { createHub?: () => HubLike };
    return typeof mod.createHub === 'function' ? mod.createHub : null;
  } catch {
    return null;
  }
}

export async function createContext(opts: { env?: NodeJS.ProcessEnv; hub?: HubFactory } = {}): Promise<RelayContext> {
  const env = opts.env ?? process.env;
  const makeHub = opts.hub ?? (await meshHub());
  const unavailable: HubFactory = () => ({
    connect: () => {
      throw new Error('signalling hub unavailable');
    },
    state: () => null,
  });
  const hq = createHq(makeHub ?? unavailable);
  return {
    env,
    limits: limitsFromEnv(env),
    hq,
    ingress: { deliver: (m) => hq.deliver(m), onDeviceReady: (fn) => hq.onDeviceReady(fn) },
    services: () => Object.fromEntries(Object.entries(SERVICE_ENV).map(([k, names]) => [k, names.some((n) => Boolean(env[n]))])),
    routers: [],
  };
}
