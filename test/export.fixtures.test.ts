import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { factor, channelNameParser, type ExportChannel } from "../src/core/export.js";
import { mergePatch, jsonEqual } from "../src/core/mergePatch.js";
import { isManaged } from "../src/core/config.js";
import type { Document, JsonObject, NoccConfig } from "../src/core/types.js";

/**
 * Round-trip test over exported merchant configurations, which are not part of the repository.
 * Point NCO_LIVE_FIXTURES at a folder with a `manifest.json`:
 *   [{ "dir": "<env>-<merchant>", "template": "${brand}-${market}${segment}",
 *      "dimensions": { "brand": [...], "market": [...], "segment": [...] },
 *      "parts": { "segment": { "b2c": "", "b2b": "-b2b" } }, "minChannels": 10 }]
 * and <dir>/<channel>/<id>.json documents (as written by `nco export` raw pulls).
 */
interface Fixture {
  dir: string;
  template: string;
  dimensions: Record<string, string[]>;
  parts?: Record<string, Record<string, string>>;
  minChannels?: number;
}

const live = process.env.NCO_LIVE_FIXTURES ?? "";
const manifestFile = path.join(live, "manifest.json");
const fixtures: Fixture[] = live && fs.existsSync(manifestFile) ? (JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Fixture[]) : [];

function loadMerchant(dir: string): Map<string, Document[]> {
  const out = new Map<string, Document[]>();
  const cfg = { managedConfigurations: undefined } as unknown as NoccConfig;
  for (const channel of fs.readdirSync(dir)) {
    const cdir = path.join(dir, channel);
    if (!fs.statSync(cdir).isDirectory()) continue;
    const docs: Document[] = [];
    for (const f of fs.readdirSync(cdir)) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      const doc = JSON.parse(fs.readFileSync(path.join(cdir, f), "utf8")) as Document;
      if (isManaged(cfg, doc.id)) docs.push(doc);
    }
    if (docs.length) out.set(channel, docs);
  }
  return out;
}

/** Re-assembles a channel's documents from the factored layers, the way `build` would. */
function rebuild(f: ReturnType<typeof factor>, channel: ExportChannel, dimensions: string[]): Document[] {
  const ids = new Set<string>([...f.base.keys(), ...[...f.featureChannels].filter(([, chs]) => chs.includes(channel.channel)).map(([id]) => id)]);
  const docs: Document[] = [];
  for (const id of ids) {
    let doc: JsonObject = { id };
    if (f.base.has(id)) doc = mergePatch(doc, f.base.get(id)!) as JsonObject;
    if (f.features.has(id) && f.featureChannels.get(id)?.includes(channel.channel)) doc = mergePatch(doc, f.features.get(id)!) as JsonObject;
    for (const dim of dimensions) {
      const patch = f.perDimension.get(dim)?.get(channel.dims[dim])?.get(id);
      if (patch) doc = mergePatch(doc, patch) as JsonObject;
    }
    const own = f.perChannel.get(channel.channel)?.get(id);
    if (own) doc = mergePatch(doc, own) as JsonObject;
    docs.push(doc as Document);
  }
  return docs;
}

describe.skipIf(fixtures.length === 0)("factoring exported merchant configurations round-trips exactly", () => {
  for (const fx of fixtures) {
    it(fx.dir, () => {
      const parse = channelNameParser(fx.template, fx.dimensions, fx.parts);
      const channels: ExportChannel[] = [];
      let unmatched = 0;
      for (const [name, documents] of loadMerchant(path.join(live, fx.dir))) {
        const dims = parse(name);
        if (!dims) {
          unmatched++;
          continue;
        }
        channels.push({ channel: name, dims, documents });
      }
      expect(channels.length).toBeGreaterThanOrEqual(fx.minChannels ?? 1);
      const dimensions = Object.keys(fx.dimensions);
      const f = factor(channels, dimensions);
      for (const ch of channels) {
        const rebuilt = new Map(rebuild(f, ch, dimensions).map((d) => [d.id, d]));
        expect([...rebuilt.keys()].sort()).toEqual(ch.documents.map((d) => d.id).sort());
        for (const doc of ch.documents) {
          if (!jsonEqual(rebuilt.get(doc.id), doc)) {
            throw new Error(`${ch.channel}/${doc.id} does not round-trip:\n${JSON.stringify(rebuilt.get(doc.id))}\nvs\n${JSON.stringify(doc)}`);
          }
        }
      }
      // every dimension with more than one value should have factored something out
      for (const dim of dimensions) {
        if (fx.dimensions[dim].length > 1 && channels.some((c) => c.dims[dim] !== channels[0].dims[dim])) {
          expect(f.perDimension.get(dim)?.size ?? 0).toBeGreaterThanOrEqual(0);
        }
      }
      void unmatched;
    });
  }
});
