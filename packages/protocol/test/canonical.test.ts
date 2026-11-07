import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/index.ts';

const jsonValue = fc.jsonValue();

function shuffleKeys(value: unknown, flip: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, flip));
  if (typeof value !== 'object' || value === null) return value;
  const keys = Object.keys(value).sort();
  if (flip) keys.reverse();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) out[key] = shuffleKeys((value as Record<string, unknown>)[key], !flip);
  return out;
}

describe('canonicalize', () => {
  it('sorts keys at every depth and drops undefined', () => {
    expect(canonicalize({ b: 1, a: { d: undefined, c: [1, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[1,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('matches JSON for undefined in arrays, dates and negative zero', () => {
    expect(canonicalize([undefined, () => 1])).toBe('[null,null]');
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalize([1, , 3])).toBe('[1,null,3]');
    expect(canonicalize({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(undefined)).toBe('null');
  });

  it('refuses values JSON cannot carry', () => {
    for (const bad of [NaN, Infinity, -Infinity, 1n]) {
      expect(() => canonicalize({ nested: [bad] })).toThrow(TypeError);
    }
  });

  it('orders keys by code unit, not locale', () => {
    expect(canonicalize({ a: 1, Z: 2, é: 3, '\u{1F600}': 4, '�': 5 })).toBe(
      '{"Z":2,"a":1,"é":3,"\u{1F600}":4,"�":5}',
    );
  });

  it('ignores key insertion order', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(canonicalize(shuffleKeys(value, true))).toBe(canonicalize(shuffleKeys(value, false)));
      }),
    );
  });

  it('is unchanged by a JSON round trip and parses back to the same value', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const text = canonicalize(value);
        expect(canonicalize(JSON.parse(JSON.stringify(value)))).toBe(text);
        expect(canonicalize(JSON.parse(text))).toBe(text);
      }),
    );
  });

  it('keeps lone surrogates stable', () => {
    const text = canonicalize({ s: '\uD800' });
    expect(canonicalize(JSON.parse(text))).toBe(text);
  });
});
