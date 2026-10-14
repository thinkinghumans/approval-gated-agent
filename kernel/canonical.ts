import { createHash } from 'node:crypto';

// Canonical JSON: object keys sorted, no whitespace, finite numbers only.
// Hashes in the audit log and the policy fingerprint are computed over this
// form, so the same content always produces the same hash regardless of the
// order in which a program happened to build the object.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, '$'));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Deep copy through canonical JSON. Used to hand agents copies, never live records. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function normalize(value: unknown, path: string): Json {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return Object.is(value, -0) ? 0 : value;
    case 'object': {
      if (Array.isArray(value)) {
        return value.map((item, i) => {
          if (item === undefined) throw new TypeError(`canonicalJson: undefined array item at ${path}[${i}]`);
          return normalize(item, `${path}[${i}]`);
        });
      }
      const out: { [key: string]: Json } = {};
      for (const key of Object.keys(value).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue; // same as JSON.stringify
        out[key] = normalize(v, `${path}.${key}`);
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}
