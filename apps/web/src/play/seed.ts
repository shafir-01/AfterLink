export type Rng = () => number;

/** No 0/O, 1/I/L or U, so a seed survives being read out loud. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SEED_LENGTH = 6;

export function newSeed(random: Rng = Math.random): string {
  let seed = '';
  for (let i = 0; i < SEED_LENGTH; i++) seed += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return seed;
}

export function cleanSeed(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const seed = raw.trim().toUpperCase();
  return seed.length === SEED_LENGTH && [...seed].every((c) => ALPHABET.includes(c)) ? seed : null;
}

/** FNV-1a into mulberry32: integer maths only, so every browser draws the same numbers. */
export function rngFor(seed: string): Rng {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
