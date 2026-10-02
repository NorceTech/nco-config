import crypto from "node:crypto";
import type { BuiltChannel, Document, Json, JsonObject } from "./types.js";
import { isObject, jsonEqual, sortKeys } from "./mergePatch.js";
import type { SecretDetector } from "../secrets/detect.js";
import type { SecretResolver } from "../secrets/providers.js";
import { findSecretRefs } from "./interpolate.js";

export type ChangeKind = "create" | "update" | "delete" | "unchanged" | "unmanaged";

export interface FieldChange {
  path: string;
  from: Json | undefined;
  to: Json | undefined;
  secret: boolean;
}

export interface DocumentChange {
  channel: string;
  id: string;
  kind: ChangeKind;
  fields: FieldChange[];
  /** Fully resolved desired document (secrets resolved) — only kept in memory, never serialised. */
  desired?: Document;
}

export interface Plan {
  env: string;
  changes: DocumentChange[];
  /** Channels that exist remotely but are not produced by this repository. */
  unknownChannels: string[];
  /** Secret names that could not be resolved; diffs for those fields are reported as unknown. */
  unresolvedSecrets: string[];
}

export const REDACTED = "<redacted>";

function flatten(v: Json | undefined, p = "", out = new Map<string, Json>()): Map<string, Json> {
  if (isObject(v)) {
    if (Object.keys(v).length === 0 && p) out.set(p, v);
    for (const [k, x] of Object.entries(v)) flatten(x, p ? `${p}.${k}` : k, out);
  } else if (v !== undefined) out.set(p, v);
  return out;
}

/** Field-level diff between two documents; arrays compare as atoms. */
export function diffDocuments(from: Document | undefined, to: Document | undefined, isSecret: (path: string) => boolean): FieldChange[] {
  const a = flatten(from ?? null);
  const b = flatten(to ?? null);
  const paths = new Set([...a.keys(), ...b.keys()]);
  const out: FieldChange[] = [];
  for (const p of [...paths].sort()) {
    if (!jsonEqual(a.get(p), b.get(p))) out.push({ path: p, from: a.get(p), to: b.get(p), secret: isSecret(p) });
  }
  return out;
}

/** Replaces ${secret:NAME} placeholders with resolved values (in memory only). */
export function resolveSecrets(doc: Document, resolver: SecretResolver, unresolved: Set<string>): Document {
  const walk = (v: Json): Json => {
    if (typeof v === "string") {
      return v.replace(/\$\{secret:([^}]+)\}/g, (whole, name: string) => {
        const value = resolver.get(name);
        if (value === undefined) {
          unresolved.add(name);
          return whole;
        }
        return value;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) {
      const out: JsonObject = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(doc) as Document;
}

export interface PlanInput {
  env: string;
  built: BuiltChannel[];
  remote: Map<string, Document[]>; // channel → documents
  remoteChannels: string[];
  isManaged: (id: string) => boolean;
  detector: SecretDetector;
  resolver?: SecretResolver;
}

export function computePlan(input: PlanInput): Plan {
  const unresolved = new Set<string>();
  const changes: DocumentChange[] = [];
  const builtNames = new Set(input.built.map((c) => c.channel));

  for (const channel of input.built) {
    const remoteDocs = new Map((input.remote.get(channel.channel) ?? []).map((d) => [d.id, sortKeys(d) as Document]));
    for (const doc of channel.documents) {
      const desired = input.resolver ? resolveSecrets(doc, input.resolver, unresolved) : doc;
      const current = remoteDocs.get(doc.id);
      remoteDocs.delete(doc.id);
      const isSecret = (p: string) => input.detector.isSecretPath(doc.id, p) || findSecretRefs(doc).some((r) => r.path === p);
      const fields = diffDocuments(current, desired, isSecret);
      changes.push({ channel: channel.channel, id: doc.id, kind: current ? (fields.length ? "update" : "unchanged") : "create", fields, desired });
    }
    for (const [id, current] of remoteDocs) {
      if (!input.isManaged(id)) changes.push({ channel: channel.channel, id, kind: "unmanaged", fields: [] });
      else changes.push({ channel: channel.channel, id, kind: "delete", fields: diffDocuments(current, undefined, (p) => input.detector.isSecretPath(id, p)) });
    }
  }
  const unknownChannels = input.remoteChannels.filter((c) => !builtNames.has(c)).sort();
  return { env: input.env, changes, unknownChannels, unresolvedSecrets: [...unresolved].sort() };
}

/** Display form of a field value: secrets are replaced by a short fingerprint so changes are visible but values are not. */
export function displayValue(v: Json | undefined, secret: boolean): string {
  if (v === undefined) return "(absent)";
  if (secret) {
    if (typeof v === "string" && /^\$\{secret:/.test(v)) return `${REDACTED} (unresolved ${v})`;
    const fp = crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 8);
    return `${REDACTED} #${fp}`;
  }
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

export function summarise(plan: Plan) {
  const count = (k: ChangeKind) => plan.changes.filter((c) => c.kind === k).length;
  return { create: count("create"), update: count("update"), delete: count("delete"), unchanged: count("unchanged"), unmanaged: count("unmanaged"), unknownChannels: plan.unknownChannels.length };
}

export function hasChanges(plan: Plan): boolean {
  return plan.changes.some((c) => c.kind === "create" || c.kind === "update" || c.kind === "delete");
}
