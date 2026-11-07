import { z } from 'zod';
import type { SignalMessage, TaskSpec } from '@afterlink/protocol';

export type IngressMessage = Extract<SignalMessage, { t: 'ingress' }>;

export interface IngressTransport {
  /** Returns true when a connected device accepted the message. */
  deliver(msg: IngressMessage): boolean;
  /** Called whenever a device becomes available to receive queued requests. */
  onDeviceReady?(fn: () => void): void;
}

export const ingressBody = z.object({
  sourceId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  request: z.object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(500).optional(),
    locationName: z.string().trim().max(80).optional(),
    location: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).optional(),
  }),
  classification: z
    .object({
      kind: z.string().trim().min(1).max(40).optional(),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      requires: z.array(z.string().max(40)).max(8).optional(),
      needs: z.array(z.object({ resource: z.string().max(40), count: z.number().int().min(1).max(10) })).max(8).optional(),
      reversible: z.boolean().optional(),
      method: z.enum(['triage', 'rules']).optional(),
    })
    .optional(),
});
export type IngressBody = z.infer<typeof ingressBody>;

export interface IngressEntry {
  sourceId: string;
  taskId: string;
  state: 'queued' | 'delivered';
  receivedAt: number;
  deliveredAt?: number;
  deliveries: number;
  message: IngressMessage;
}

export interface IngressServiceOptions {
  transport: IngressTransport;
  objective?: string;
  maxQueue?: number;
  now?: () => number;
}

export function toSpec(body: IngressBody, objective: string): TaskSpec {
  const c = body.classification ?? {};
  const r = body.request;
  return {
    id: `ext-${body.sourceId}`,
    kind: c.kind ?? 'assist',
    title: r.title,
    brief: r.description || r.title,
    objective,
    priority: c.priority ?? 2,
    location: r.location ?? { x: 50, y: 50 },
    locationName: r.locationName || 'Location not given',
    requires: c.requires ?? [],
    needs: c.needs ?? [],
    dependsOn: [],
    reversible: c.reversible ?? true,
  };
}

export class IngressService {
  private entries = new Map<string, IngressEntry>();
  private pending: string[] = [];
  private readonly objective: string;
  private readonly maxQueue: number;
  private readonly now: () => number;

  constructor(private o: IngressServiceOptions) {
    this.objective = o.objective || 'assist';
    this.maxQueue = o.maxQueue ?? 1000;
    this.now = o.now ?? Date.now;
    o.transport.onDeviceReady?.(() => this.flush());
  }

  /** Accepts a request once per source id. Repeat deliveries return the existing entry. */
  accept(body: IngressBody): { entry: IngressEntry; duplicate: boolean } | { full: true } {
    const existing = this.entries.get(body.sourceId);
    if (existing) {
      existing.deliveries += 1;
      return { entry: existing, duplicate: true };
    }
    if (this.pending.length >= this.maxQueue) return { full: true };
    const spec = toSpec(body, this.objective);
    const entry: IngressEntry = {
      sourceId: body.sourceId,
      taskId: spec.id,
      state: 'queued',
      receivedAt: this.now(),
      deliveries: 1,
      message: { t: 'ingress', ref: body.sourceId, spec },
    };
    this.entries.set(entry.sourceId, entry);
    if (this.o.transport.deliver(entry.message)) this.markDelivered(entry);
    else this.pending.push(entry.sourceId);
    return { entry, duplicate: false };
  }

  flush(): number {
    let sent = 0;
    while (this.pending.length) {
      const entry = this.entries.get(this.pending[0]!);
      if (!entry) {
        this.pending.shift();
        continue;
      }
      if (!this.o.transport.deliver(entry.message)) break;
      this.pending.shift();
      this.markDelivered(entry);
      sent += 1;
    }
    return sent;
  }

  get(sourceId: string): IngressEntry | undefined {
    return this.entries.get(sourceId);
  }

  queued(): number {
    return this.pending.length;
  }

  private markDelivered(entry: IngressEntry) {
    entry.state = 'delivered';
    entry.deliveredAt = this.now();
  }
}
