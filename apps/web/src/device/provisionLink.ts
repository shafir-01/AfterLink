import { b64u, fromB64u } from '@afterlink/protocol';
import type { ProvisionBundle } from '@afterlink/protocol';

const STORED = 'afterlink.device.bundle';

async function pipe(bytes: Uint8Array, transform: { readable: ReadableStream; writable: WritableStream }): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform as ReadableWritablePair);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeBundle(bundle: ProvisionBundle): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(bundle));
  return b64u(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeBundle(text: string): Promise<ProvisionBundle> {
  const json = await pipe(fromB64u(text), new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(json)) as ProvisionBundle;
}

/** A link that provisions a real phone. The relay address rides along when it is not the page's own origin. */
export async function deviceLink(bundle: ProvisionBundle, relay?: string): Promise<string> {
  const query = new URLSearchParams({ p: await encodeBundle(bundle) });
  if (relay) query.set('relay', relay);
  return `${window.location.origin}${window.location.pathname}#/device?${query}`;
}

export function loadStoredBundle(): { bundle: ProvisionBundle; relay?: string } | null {
  try {
    const stored = localStorage.getItem(STORED);
    return stored ? (JSON.parse(stored) as { bundle: ProvisionBundle; relay?: string }) : null;
  } catch {
    return null;
  }
}

export function storeBundle(bundle: ProvisionBundle, relay?: string) {
  try {
    localStorage.setItem(STORED, JSON.stringify({ bundle, relay }));
  } catch {
    // Without storage this device still runs until the page closes.
  }
}

export function clearStoredBundle() {
  try {
    localStorage.removeItem(STORED);
  } catch {
    // Nothing was stored.
  }
}

export function signalUrl(relay?: string): string {
  const base = relay || import.meta.env.VITE_RELAY_URL || window.location.origin;
  const url = new URL('/signal', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
