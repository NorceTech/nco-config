import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ChannelSpec, Json, JsonObject, NoccConfig } from "./types.js";
import { interpolateTokens } from "./interpolate.js";
import { isObject } from "./mergePatch.js";

export interface LayerFile {
  /** Document id (from the file's `id` or the file name). */
  id: string;
  file: string;
  patch: JsonObject;
}

const DOC_EXT = /\.(ya?ml|json)$/;

/** Reads all document patches in a layer directory. Missing directory → empty list. */
export function readLayerDir(dir: string): LayerFile[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: LayerFile[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!DOC_EXT.test(name)) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, "utf8");
    const parsed = (name.endsWith(".json") ? JSON.parse(text) : parseYaml(text)) as Json;
    if (parsed === null || parsed === undefined) continue;
    if (!isObject(parsed)) throw new Error(`${file}: a layer file must be a mapping`);
    const idFromFile = name.replace(DOC_EXT, "");
    const id = typeof parsed.id === "string" ? parsed.id : idFromFile;
    if (typeof parsed.id === "string" && parsed.id !== idFromFile) {
      throw new Error(`${file}: id "${parsed.id}" does not match file name "${idFromFile}"`);
    }
    out.push({ id, file, patch: parsed });
  }
  return out;
}

/**
 * Expands the configured layer templates for one channel in one environment into concrete
 * directories, in merge order. A template containing {feature} is repeated per enabled feature.
 */
export function layerDirsFor(config: NoccConfig, root: string, spec: ChannelSpec, env: string, target: string): string[] {
  const base: Record<string, string> = { ...spec.dims, env, target, channel: spec.name, merchant: config.merchant, slug: config.slug ?? config.merchant };
  const dirs: string[] = [];
  for (const template of config.layers) {
    if (template.includes("${feature}")) {
      for (const feature of spec.features) dirs.push(path.join(root, interpolateTokens(template, { ...base, feature }, "layers")));
    } else {
      dirs.push(path.join(root, interpolateTokens(template, base, "layers")));
    }
  }
  return dirs;
}
