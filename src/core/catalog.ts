import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Document, JsonObject } from "./types.js";
import { interpolateTokens } from "./interpolate.js";
import { isObject } from "./mergePatch.js";

export interface TargetUrls {
  /** Public base URL of an adapter; tokens {slug} {host}. */
  public: string;
  /** Internal base URL of an adapter (required by adapter schemas); tokens {host}. */
  internal: string;
  /** Configuration API base URL; tokens {slug}. */
  configuration: string;
  /** Base of the configuration service's own schema URL. */
  configurationSchemaBase: string;
  /**
   * Where to *fetch* schemas from when validating: a canonical host that serves every merchant's schema,
   * so validation works before a merchant's slug exists. Tokens {host}. Optional; defaults to the document's $schema.
   */
  schemaFetchPublic?: string;
  schemaFetchConfiguration?: string;
}

export interface AdapterEntry {
  /** Host name segment of the adapter, e.g. walley-adapter. */
  host: string;
  /** OpenAPI schema version path segment, v1 or v2. */
  schema?: string;
  /** JSON paths (dotted, `[]` for array items) holding credentials. */
  secrets?: string[];
  /** Set when the document has no adapter block (order-service documents). */
  service?: boolean;
}

export interface Catalog {
  version: number;
  targets: Record<string, TargetUrls>;
  adapters: Record<string, AdapterEntry>;
  /** Key-name regexes (case-insensitive) that mark a leaf as a credential when no explicit path matches. */
  secretKeyPatterns: string[];
  /** Key-name regexes that override secretKeyPatterns (e.g. keys containing "url"). */
  nonSecretKeyPatterns: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG_FILE = path.resolve(here, "../../catalog/adapters.yaml");

export function loadCatalog(file = DEFAULT_CATALOG_FILE): Catalog {
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as Catalog;
  if (!raw || typeof raw !== "object" || !raw.targets || !raw.adapters) throw new Error(`${file}: not a catalog file`);
  raw.secretKeyPatterns ??= [];
  raw.nonSecretKeyPatterns ??= [];
  return raw;
}

export function targetUrls(catalog: Catalog, target: string): TargetUrls {
  const t = catalog.targets[target];
  if (!t) throw new Error(`unknown target "${target}" (catalog has: ${Object.keys(catalog.targets).join(", ")})`);
  return t;
}

export interface Derived {
  schema: string;
  adapter?: { internalUrl: string; publicUrl: string };
}

/** The conventional `$schema` and `adapter` URLs for a document id in a target environment. */
export function deriveUrls(catalog: Catalog, target: string, slug: string, id: string): Derived {
  const urls = targetUrls(catalog, target);
  const entry = catalog.adapters[id];
  if (!entry || entry.service) {
    return { schema: `${interpolateTokens(urls.configurationSchemaBase, { slug }, "catalog")}/openapi/v1/schemas/configuration.json` };
  }
  const tokens = { slug, host: entry.host };
  const publicUrl = interpolateTokens(urls.public, tokens, "catalog");
  const internalUrl = interpolateTokens(urls.internal, tokens, "catalog");
  return {
    schema: `${publicUrl}/openapi/${entry.schema ?? "v1"}/schemas/${id}.json`,
    adapter: { internalUrl, publicUrl },
  };
}

/** Fills `$schema` and `adapter.*` when the document does not set them explicitly. */
export function applyDerived(catalog: Catalog, target: string, slug: string, doc: Document): Document {
  const derived = deriveUrls(catalog, target, slug, doc.id);
  const out: Document = { ...doc };
  if (out.$schema === undefined) out.$schema = derived.schema;
  if (derived.adapter) {
    const adapter: JsonObject = isObject(out.adapter) ? { ...out.adapter } : {};
    adapter.internalUrl ??= derived.adapter.internalUrl;
    adapter.publicUrl ??= derived.adapter.publicUrl;
    out.adapter = adapter;
  }
  return out;
}

/**
 * URL to fetch a document's schema from. When the document uses the conventional `$schema`, the canonical
 * per-environment host is used (identical schema, resolvable for any slug); explicit `$schema` values are fetched as-is.
 */
export function schemaFetchUrl(catalog: Catalog, target: string, slug: string, doc: Document): string | undefined {
  if (typeof doc.$schema !== "string") return undefined;
  const urls = targetUrls(catalog, target);
  const derived = deriveUrls(catalog, target, slug, doc.id);
  if (doc.$schema !== derived.schema) return doc.$schema;
  const entry = catalog.adapters[doc.id];
  if (!entry || entry.service) {
    return urls.schemaFetchConfiguration ? `${urls.schemaFetchConfiguration}/openapi/v1/schemas/configuration.json` : doc.$schema;
  }
  if (!urls.schemaFetchPublic) return doc.$schema;
  return `${interpolateTokens(urls.schemaFetchPublic, { host: entry.host }, "catalog")}/openapi/${entry.schema ?? "v1"}/schemas/${doc.id}.json`;
}

/** Fields of a live document that equal the convention — removable on export, reportable as drift otherwise. */
export function conventionDiff(catalog: Catalog, target: string, slug: string, doc: Document): string[] {
  const derived = deriveUrls(catalog, target, slug, doc.id);
  const drift: string[] = [];
  if (typeof doc.$schema === "string" && doc.$schema !== derived.schema) drift.push(`$schema is ${doc.$schema}, convention ${derived.schema}`);
  if (derived.adapter && isObject(doc.adapter)) {
    for (const k of ["internalUrl", "publicUrl"] as const) {
      if (doc.adapter[k] !== undefined && doc.adapter[k] !== derived.adapter[k]) drift.push(`adapter.${k} is ${String(doc.adapter[k])}, convention ${derived.adapter[k]}`);
    }
  }
  return drift;
}
