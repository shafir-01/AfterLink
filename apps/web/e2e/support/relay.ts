import { spawn, type ChildProcess } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { b64u, generateKeys, type AnyEvent, type ProvisionBundle } from '@afterlink/protocol';
import { festivalCapsule, provision } from '@afterlink/mission';

export const RELAY_PORT = 4193;
export const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;

const PAID_KEYS = ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'N8N_API_KEY', 'N8N_BASE_URL', 'N8N_WEBHOOK_URL', 'AFTERLINK_N8N_WEBHOOK_URL', 'N8N_INGRESS_SECRET'];

/** A real relay process. It gets no provider keys, so nothing it does can reach a paid service. */
export class RelayProcess {
  private child: ChildProcess | null = null;

  async start() {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1', AFTERLINK_AI_ENABLED: '0', AFTERLINK_ADMIN_TOKEN: 'e2e' };
    for (const key of PAID_KEYS) delete env[key];
    this.child = spawn(process.execPath, ['--import', 'tsx', 'apps/relay/src/server.ts'], { env, stdio: 'ignore' });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const up = await fetch(`${RELAY_URL}/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (up) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('relay did not start');
  }

  /** Ends the process outright, the way a crash or a pulled plug would. */
  async kill() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }

  async isUp() {
    return fetch(`${RELAY_URL}/health`).then(
      (r) => r.ok,
      () => false,
    );
  }
}

export function provisionMission(room: string): Record<string, ProvisionBundle> {
  const issuer = generateKeys();
  return provision(festivalCapsule(issuer), issuer, room).bundles;
}

/** The same link a mission lead hands to a real phone. */
export function deviceLink(bundle: ProvisionBundle): string {
  const p = b64u(deflateRawSync(Buffer.from(JSON.stringify(bundle))));
  return `/#/device?${new URLSearchParams({ p, relay: RELAY_URL })}`;
}

/** The signed log exactly as this device stored it. */
export function storedLog(page: Page, bundle: ProvisionBundle): Promise<AnyEvent[]> {
  const name = `afterlink-${bundle.room}.${bundle.actor.publicKey.slice(0, 16)}`;
  return page.evaluate(
    (db) =>
      new Promise<AnyEvent[]>((resolve, reject) => {
        const open = indexedDB.open(db);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('events', 'readonly').objectStore('events').getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            open.result.close();
            resolve(all.result as AnyEvent[]);
          };
        };
      }),
    name,
  );
}

/** Every actor's chain must run 1, 2, 3 with each event naming the one before it. Returns what is wrong. */
export function chainFaults(events: AnyEvent[]): string[] {
  const byActor = new Map<string, AnyEvent[]>();
  for (const e of events) byActor.set(e.actor, [...(byActor.get(e.actor) ?? []), e]);
  const faults: string[] = [];
  for (const [actor, chain] of byActor) {
    const sorted = [...chain].sort((a, b) => a.seq - b.seq);
    const start = sorted[0]!.seq;
    sorted.forEach((e, i) => {
      if (e.seq !== start + i) faults.push(`${actor.slice(0, 6)}: seq ${e.seq} where ${start + i} was due`);
      if (i > 0 && e.prev !== sorted[i - 1]!.id) faults.push(`${actor.slice(0, 6)}: seq ${e.seq} does not chain to seq ${sorted[i - 1]!.seq}`);
    });
  }
  return faults;
}
