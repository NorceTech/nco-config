import type { Document, Json, JsonObject } from "./types.js";
import { isObject, jsonEqual } from "./mergePatch.js";
import { leaves } from "./build.js";

export interface ExportChannel {
  channel: string;
  /** Dimension values parsed from the channel name; empty when no dimensions are declared. */
  dims: Record<string, string>;
  documents: Document[];
}

export interface Factored {
  /** Documents every channel has: fields identical across all channels. */
  base: Map<string, JsonObject>; // id → patch
  /** Documents only some channels have: id → common fields; enabled per channel via `featureChannels`. */
  features: Map<string, JsonObject>;
  featureChannels: Map<string, string[]>;
  /** dim → value → id → patch: fields constant within one dimension value and differing across values. */
  perDimension: Map<string, Map<string, Map<string, JsonObject>>>;
  /** channel → id → patch: everything else. */
  perChannel: Map<string, Map<string, JsonObject>>;
  notes: string[];
}

export function setPath(target: JsonObject, dotted: string, value: Json): void {
  const parts = dotted.split(".");
  let cur: JsonObject = target;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(cur[p])) cur[p] = {};
    cur = cur[p] as JsonObject;
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Builds a parser from a channel name template like "{brand}-{market}{segment}" back to dimension values.
 * Fragments (channelNameParts) are tried longest first so an empty fragment (b2c) only matches when nothing else does.
 */
export function channelNameParser(
  template: string,
  dimensions: Record<string, string[]>,
  parts: Record<string, Record<string, string>> = {},
): (name: string) => Record<string, string> | undefined {
  const names: string[] = [];
  const fragmentToValue: Array<Map<string, string>> = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // after escaping, "${brand}" reads "\$\{brand\}"
  const source = esc(template).replace(/\\\$\\\{([a-z][a-z0-9_]*)\\\}/gi, (_, dim: string) => {
    const values = dimensions[dim];
    if (!values) throw new Error(`channelName uses unknown dimension "${dim}"`);
    names.push(dim);
    const map = new Map<string, string>();
    for (const v of values) map.set(parts[dim]?.[v] ?? v, v);
    fragmentToValue.push(map);
    const fragments = [...map.keys()].sort((a, b) => b.length - a.length);
    return `(${fragments.map(esc).join("|")})`;
  });
  const re = new RegExp(`^${source}$`);
  return (name) => {
    const m = re.exec(name);
    if (!m) return undefined;
    const out: Record<string, string> = {};
    names.forEach((n, i) => {
      out[n] = fragmentToValue[i].get(m[i + 1]) ?? m[i + 1];
    });
    return out;
  };
}

/**
 * Splits live documents into base / per-dimension / per-channel patches.
 * Deterministic: a leaf goes to the most general layer where its value is constant.
 */
export function factor(channels: ExportChannel[], dimensions: string[]): Factored {
  const out: Factored = { base: new Map(), features: new Map(), featureChannels: new Map(), perDimension: new Map(), perChannel: new Map(), notes: [] };
  const ids = new Set(channels.flatMap((c) => c.documents.map((d) => d.id)));

  for (const id of [...ids].sort()) {
    const holders = channels.filter((c) => c.documents.some((d) => d.id === id));
    // A document every channel has is a base document; one that only some channels have becomes a feature
    // (named after the document) so the layer system also decides *presence*, not just values.
    const universal = holders.length === channels.length;
    const common = universal ? out.base : out.features;
    if (!universal) out.featureChannels.set(id, holders.map((c) => c.channel));
    const docLeaves = new Map(holders.map((c) => [c.channel, leaves(c.documents.find((d) => d.id === id)!)]));
    const allPaths = new Set<string>();
    for (const lv of docLeaves.values()) for (const p of lv.keys()) allPaths.add(p);

    for (const path of [...allPaths].sort()) {
      if (path === "id") continue;
      const values = holders.map((c) => ({ c, v: docLeaves.get(c.channel)!.get(path) }));
      const present = values.filter((x) => x.v !== undefined);
      const first = present[0]?.v;
      const everywhere = present.length === holders.length && present.every((x) => jsonEqual(x.v, first));
      if (everywhere) {
        if (!common.has(id)) common.set(id, {});
        setPath(common.get(id)!, path, first as Json);
        continue;
      }
      // Try one dimension at a time: constant within each value of that dimension, present in all holders.
      let placed = false;
      if (present.length === holders.length) {
        for (const dim of dimensions) {
          const groups = new Map<string, Json[]>();
          for (const { c, v } of present) {
            const key = c.dims[dim];
            if (key === undefined) {
              groups.clear();
              break;
            }
            groups.set(key, [...(groups.get(key) ?? []), v as Json]);
          }
          if (groups.size < 2) continue;
          const consistent = [...groups.values()].every((vs) => vs.every((v) => jsonEqual(v, vs[0])));
          if (!consistent) continue;
          if (!out.perDimension.has(dim)) out.perDimension.set(dim, new Map());
          const byValue = out.perDimension.get(dim)!;
          for (const [value, vs] of groups) {
            if (!byValue.has(value)) byValue.set(value, new Map());
            const docs = byValue.get(value)!;
            if (!docs.has(id)) docs.set(id, {});
            setPath(docs.get(id)!, path, vs[0]);
          }
          placed = true;
          break;
        }
      }
      if (placed) continue;
      for (const { c, v } of present) {
        if (!out.perChannel.has(c.channel)) out.perChannel.set(c.channel, new Map());
        const docs = out.perChannel.get(c.channel)!;
        if (!docs.has(id)) docs.set(id, {});
        setPath(docs.get(id)!, path, v as Json);
      }
      if (present.length !== holders.length) {
        out.notes.push(`${id}.${path}: present in ${present.length}/${holders.length} channels → kept per channel`);
      }
    }
    // A feature document with no common fields still needs a (possibly empty) file so the layer exists.
    if (!universal && !common.has(id)) common.set(id, {});
  }
  return out;
}
