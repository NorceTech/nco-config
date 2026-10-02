import type { Catalog } from "../core/catalog.js";
import type { Document, Json, JsonObject } from "../core/types.js";
import { isObject } from "../core/mergePatch.js";

/**
 * Decides which leaf paths of a document hold credentials.
 * Order: JSON Schema (`format: password` / `writeOnly`) → catalog paths for the adapter → key-name patterns.
 */
export class SecretDetector {
  private readonly keyPatterns: RegExp[];
  private readonly nonSecretPatterns: RegExp[];

  constructor(
    private readonly catalog: Catalog,
    private readonly schemaSecretPaths: (id: string) => string[] = () => [],
  ) {
    this.keyPatterns = catalog.secretKeyPatterns.map((p) => new RegExp(p, "i"));
    this.nonSecretPatterns = catalog.nonSecretKeyPatterns.map((p) => new RegExp(p, "i"));
  }

  private explicitPaths(id: string): string[] {
    return [...(this.schemaSecretPaths(id) ?? []), ...(this.catalog.adapters[id]?.secrets ?? [])];
  }

  /** Normalises `a[3].b` → `a[].b` so array items match catalog paths. */
  static normalisePath(p: string): string {
    return p.replace(/\[\d+\]/g, "[]");
  }

  isSecretPath(id: string, dottedPath: string): boolean {
    const norm = SecretDetector.normalisePath(dottedPath);
    if (this.explicitPaths(id).includes(norm)) return true;
    const key = norm.split(".").pop() ?? "";
    if (this.nonSecretPatterns.some((r) => r.test(key))) return false;
    return this.keyPatterns.some((r) => r.test(key));
  }

  /** Lists leaf paths with string values that are secrets. */
  secretLeaves(doc: Document): Array<{ path: string; value: string }> {
    const out: Array<{ path: string; value: string }> = [];
    const walk = (v: Json, p: string) => {
      if (typeof v === "string") {
        if (p && this.isSecretPath(doc.id, p) && !/^\$\{secret:/.test(v)) out.push({ path: p, value: v });
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
      else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    };
    walk(doc, "");
    return out;
  }
}

/** Returns a copy of the document with every secret leaf replaced by `replacement(path, value)`. */
export function replaceSecretLeaves(detector: SecretDetector, doc: Document, replacement: (path: string, value: string) => string): Document {
  const walk = (v: Json, p: string): Json => {
    if (typeof v === "string") return p && detector.isSecretPath(doc.id, p) && !/^\$\{secret:/.test(v) ? replacement(p, v) : v;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}[${i}]`));
    if (isObject(v)) {
      const out: JsonObject = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, p ? `${p}.${k}` : k);
      return out;
    }
    return v;
  };
  return walk(doc, "") as Document;
}

/** Conventional secret name: ADAPTER_PATH, e.g. WALLEY_CHECKOUT_ADAPTER_API_SECRET. */
export function secretNameFor(id: string, dottedPath: string, scopeSuffix?: string): string {
  const base = `${id}_${SecretDetector.normalisePath(dottedPath).replace(/\[\]/g, "")}`
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return scopeSuffix ? `${base}_${scopeSuffix.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}` : base;
}

/** Heuristics for strings that look like credentials, used to scan tracked files. */
export const CREDENTIAL_SHAPES: Array<{ name: string; re: RegExp }> = [
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "connection-string", re: /AccountKey=[A-Za-z0-9+/=]{20,}/ },
  { name: "hex-32", re: /\b[0-9a-f]{32,}\b/i },
  { name: "base64-blob", re: /\b(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{32,}={0,2}\b/ },
];
