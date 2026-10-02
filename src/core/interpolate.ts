import type { Json, JsonObject } from "./types.js";
import { isObject } from "./mergePatch.js";

export interface Scope {
  /** ${name} tokens: dimension values plus env, target, channel, deployedChannel, merchant, slug. */
  tokens: Record<string, string>;
  /** ${var:name} */
  vars: Record<string, string>;
  /** ${lookup:dotted.path} */
  lookups: Json;
}

export class InterpolationError extends Error {}

/**
 * Tool placeholders always use `${...}`; plain `{...}` is passed through untouched because the platform's
 * own templates use it (e.g. `{orderId}`, `{productId}`, `{merchant}`).
 */
const TOKEN = /\$\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const REF = /\$\{(var|lookup|secret):([^}]+)\}/g;

/** `${market}` → value, `${MARKET}` → upper-cased value, `${Market}` → capitalised value. Unknown names throw. */
export function interpolateTokens(text: string, tokens: Record<string, string>, where: string): string {
  return text.replace(TOKEN, (_whole, raw: string) => {
    const lower = raw.toLowerCase();
    const value = tokens[raw] ?? tokens[lower] ?? tokens[raw.replace(/^[A-Z]/, (c) => c.toLowerCase())];
    if (value === undefined) {
      throw new InterpolationError(`${where}: unknown placeholder \${${raw}} (known: ${Object.keys(tokens).sort().join(", ")})`);
    }
    if (tokens[raw] !== undefined) return value;
    if (raw === raw.toUpperCase()) return value.toUpperCase();
    if (raw[0] === raw[0].toUpperCase()) return value.charAt(0).toUpperCase() + value.slice(1);
    return value;
  });
}

function lookupPath(root: Json, path: string, where: string): Json {
  let cur: Json | undefined = root;
  for (const seg of path.split(".")) {
    if (!isObject(cur) || !(seg in cur)) {
      throw new InterpolationError(`${where}: lookup "${path}" not found (missing "${seg}")`);
    }
    cur = cur[seg];
  }
  return cur as Json;
}

/**
 * Resolves `${token}` and `${var:}`/`${lookup:}` references in a string. `${secret:}` is left intact.
 * A string that is exactly one `${lookup:}`/`${var:}` reference may resolve to a non-string JSON value.
 */
export function interpolateString(text: string, scope: Scope, where: string): Json {
  const withTokens = interpolateTokens(text, scope.tokens, where);
  const single = /^\$\{(var|lookup):([^}]+)\}$/.exec(withTokens);
  if (single) {
    const [, kind, name] = single;
    const value = kind === "var" ? scope.vars[name] : lookupPath(scope.lookups, name, where);
    if (value === undefined) throw new InterpolationError(`${where}: variable "${name}" is not defined`);
    return value as Json;
  }
  return withTokens.replace(REF, (whole, kind: string, name: string) => {
    if (kind === "secret") return whole;
    const value = kind === "var" ? scope.vars[name] : lookupPath(scope.lookups, name, where);
    if (value === undefined) throw new InterpolationError(`${where}: variable "${name}" is not defined`);
    if (typeof value === "object") {
      throw new InterpolationError(`${where}: "${name}" resolves to an object and cannot be embedded in a string`);
    }
    return String(value);
  });
}

/** Recursively interpolates keys and string values of a JSON value. */
export function interpolateJson(value: Json, scope: Scope, where: string): Json {
  if (typeof value === "string") return interpolateString(value, scope, where);
  if (Array.isArray(value)) return value.map((v, i) => interpolateJson(v, scope, `${where}[${i}]`));
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const key = interpolateTokens(k, scope.tokens, where);
      out[key] = interpolateJson(v, scope, `${where}.${key}`);
    }
    return out;
  }
  return value;
}

/** Lists ${secret:NAME} references in a JSON value with their paths. */
export function findSecretRefs(value: Json, path = ""): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  if (typeof value === "string") {
    for (const m of value.matchAll(/\$\{secret:([^}]+)\}/g)) out.push({ path, name: m[1] });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findSecretRefs(v, `${path}[${i}]`)));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) out.push(...findSecretRefs(v, path ? `${path}.${k}` : k));
  }
  return out;
}
