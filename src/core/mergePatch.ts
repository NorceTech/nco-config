import type { Json, JsonObject } from "./types.js";

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * JSON Merge Patch (RFC 7386). Objects merge recursively, `null` removes a key,
 * arrays and scalars replace. Returns a new value; inputs are not mutated.
 */
export function mergePatch(target: Json | undefined, patch: Json): Json {
  if (!isObject(patch)) return structuredClone(patch);
  const result: JsonObject = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = mergePatch(result[key], value);
    }
  }
  return result;
}

/** Deep structural equality for JSON values (key order ignored). */
export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => jsonEqual(a[k], b[k]));
  }
  return false;
}

/** Stable key-sorted clone, for deterministic output and hashing. */
export function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export { isObject };
