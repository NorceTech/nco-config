import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ajvModule from "ajv";
import ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ErrorObject } from "ajv";
import type { Document, Json, JsonObject } from "./types.js";

// ajv ships CommonJS; under NodeNext the default import is the module object, so unwrap `.default` when present.
type Unwrap<T> = T extends { default: infer D } ? D : T;
const unwrap = <T>(m: T): Unwrap<T> => ((m as { default?: unknown }).default ?? m) as Unwrap<T>;
const Ajv = unwrap(ajvModule);
const Ajv2020 = unwrap(ajv2020Module);
const addFormats = unwrap(addFormatsModule);
import { isObject } from "./mergePatch.js";

export interface SchemaIssue {
  path: string;
  message: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetches and caches the JSON Schemas referenced by documents' `$schema`, validates documents,
 * and extracts secret-marked paths (`format: password` / `writeOnly`).
 */
export class SchemaStore {
  private readonly memory = new Map<string, JsonObject>();

  constructor(
    private readonly cacheDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly offline = false,
  ) {}

  private cacheFile(url: string): string {
    return path.join(this.cacheDir, crypto.createHash("sha1").update(url).digest("hex") + ".json");
  }

  async get(url: string, refresh = false): Promise<JsonObject> {
    const inMemory = this.memory.get(url);
    if (inMemory && !refresh) return inMemory;
    const file = this.cacheFile(url);
    if (!refresh && fs.existsSync(file)) {
      const fresh = Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL_MS;
      if (fresh || this.offline) {
        const cached = JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
        this.memory.set(url, cached);
        return cached;
      }
    }
    if (this.offline) throw new Error(`schema ${url} is not cached and --offline was given`);
    const res = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      if (fs.existsSync(file)) {
        const stale = JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
        this.memory.set(url, stale);
        return stale;
      }
      throw new Error(`could not fetch schema ${url}: ${res.status} ${res.statusText}`);
    }
    const schema = (await res.json()) as JsonObject;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(schema));
    this.memory.set(url, schema);
    return schema;
  }

  private compile(schema: JsonObject) {
    const draft = typeof schema.$schema === "string" && schema.$schema.includes("2020-12");
    const opts = { strict: false, allErrors: true, useDefaults: false, logger: false as const };
    const ajv = draft ? new Ajv2020(opts) : new Ajv(opts);
    addFormats(ajv);
    // formats used by adapter schemas that ajv-formats does not know
    ajv.addFormat("decimal", /^-?\d+(\.\d+)?$/);
    ajv.addFormat("password", () => true);
    ajv.addFormat("json", () => true);
    return ajv.compile(schema);
  }

  /**
   * Validates a document against its `$schema` (fetched from `fetchUrl` when given).
   * `${secret:...}` placeholders are strings and pass string checks.
   */
  async validate(doc: Document, fetchUrl?: string): Promise<SchemaIssue[]> {
    if (typeof doc.$schema !== "string") return [{ path: "$schema", message: "missing $schema" }];
    const schema = await this.get(fetchUrl ?? doc.$schema);
    const validate = this.compile(schema);
    const ok = validate(doc);
    if (ok) return [];
    return (validate.errors ?? []).map((e: ErrorObject) => ({ path: e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)", message: e.message ?? "invalid" }));
  }

  /** Dotted paths the schema marks as credentials. */
  async secretPaths(schemaUrl: string): Promise<string[]> {
    const schema = await this.get(schemaUrl);
    const out: string[] = [];
    const seen = new Set<JsonObject>();
    const resolveRef = (ref: string): JsonObject | undefined => {
      if (!ref.startsWith("#/")) return undefined;
      let cur: Json = schema;
      for (const seg of ref.slice(2).split("/")) {
        if (!isObject(cur) || !(seg in cur)) return undefined;
        cur = cur[seg];
      }
      return isObject(cur) ? cur : undefined;
    };
    const walk = (node: JsonObject, p: string) => {
      if (seen.has(node)) return;
      seen.add(node);
      if (typeof node.$ref === "string") {
        const target = resolveRef(node.$ref);
        if (target) walk(target, p);
        return;
      }
      if (node.format === "password" || node.writeOnly === true) {
        if (p) out.push(p);
        return;
      }
      if (isObject(node.properties)) {
        for (const [k, v] of Object.entries(node.properties)) if (isObject(v)) walk(v, p ? `${p}.${k}` : k);
      }
      if (isObject(node.items)) walk(node.items, `${p}[]`);
      for (const combo of ["allOf", "anyOf", "oneOf"]) {
        const arr = node[combo];
        if (Array.isArray(arr)) for (const v of arr) if (isObject(v)) walk(v, p);
      }
    };
    walk(schema, "");
    return out;
  }
}
