/**
 * Canonical JSON: sorted keys, undefined dropped, no whitespace.
 * A value and its JSON round trip always encode to the same string, so hashes
 * survive every transport. Non-finite numbers and bigints are refused because
 * JSON cannot carry them faithfully, and hostile nesting is refused outright.
 */
export function canonicalize(value: unknown): string {
  return encode(value, 0) ?? 'null';
}

const MAX_DEPTH = 32;

function encode(value: unknown, depth: number): string | undefined {
  if (depth > MAX_DEPTH) throw new RangeError('Value is nested too deeply to canonicalize');
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalize ${value}`);
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('Cannot canonicalize a bigint');
    case 'object':
      break;
    default:
      return undefined;
  }
  if (value === null) return 'null';
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') return encode(toJSON.call(value), depth);
  if (Array.isArray(value)) return `[${Array.from(value, (v) => encode(v, depth + 1) ?? 'null').join(',')}]`;
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = encode(record[key], depth + 1);
    if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${fields.join(',')}}`;
}
