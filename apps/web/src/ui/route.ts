import { useSyncExternalStore } from 'react';

export type RouteName = 'stage' | 'device' | 'lead' | 'debrief' | 'compose';

export interface Route {
  name: RouteName | 'unknown';
  /** Path segments after the route name. */
  rest: string[];
  params: URLSearchParams;
}

const NAMES: RouteName[] = ['device', 'lead', 'debrief', 'compose'];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const queryAt = raw.indexOf('?');
  const path = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const params = new URLSearchParams(queryAt < 0 ? '' : raw.slice(queryAt + 1));
  const [head = '', ...rest] = path.split('/').filter(Boolean);
  if (!head) return { name: 'stage', rest, params };
  return { name: NAMES.find((name) => name === head) ?? 'unknown', rest, params };
}

export function navigate(path: string) {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}

let cachedHash = '';
let cachedRoute = parseRoute('');

function snapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseRoute(hash);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore((fn) => {
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, snapshot);
}
