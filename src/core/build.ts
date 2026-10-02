import type { BuildResult, BuiltChannel, Document, Json, JsonObject } from "./types.js";
import type { Project } from "./config.js";
import { environmentOf, isManaged } from "./config.js";
import type { Catalog } from "./catalog.js";
import { applyDerived, deriveUrls } from "./catalog.js";
import { expandChannels, deployedChannelName } from "./matrix.js";
import { layerDirsFor, readLayerDir } from "./layers.js";
import { interpolateJson, type Scope } from "./interpolate.js";
import { mergePatch, isObject, sortKeys } from "./mergePatch.js";

export interface BuildOptions {
  /** Restrict to these deployed channel names. */
  channels?: string[];
}

/** Renders every channel of one environment into final documents (secrets still as placeholders). */
export function buildEnvironment(project: Project, catalog: Catalog, env: string, options: BuildOptions = {}): BuildResult {
  const { config, root } = project;
  const environment = environmentOf(config, env);
  const slug = config.slug ?? config.merchant;
  const warnings: string[] = [];
  const channels: BuiltChannel[] = [];

  for (const spec of expandChannels(config)) {
    const channel = deployedChannelName(spec, environment);
    if (options.channels && !options.channels.includes(channel)) continue;

    const patches = new Map<string, JsonObject>();
    const sources: string[] = [];
    for (const dir of layerDirsFor(config, root, spec, env, environment.target)) {
      for (const file of readLayerDir(dir)) {
        sources.push(file.file);
        patches.set(file.id, mergePatch(patches.get(file.id), file.patch) as JsonObject);
      }
    }

    const scope: Scope = {
      // {channel} is the logical name (same in every environment); {deployedChannel} includes the env prefix/suffix.
      tokens: { ...spec.dims, env, target: environment.target, channel: spec.name, deployedChannel: channel, merchant: config.merchant, slug },
      vars: { ...(config.vars ?? {}), ...(environment.vars ?? {}) },
      lookups: project.lookups,
    };

    const documents: Document[] = [];
    for (const [id, patch] of patches) {
      if (!isManaged(config, id)) {
        warnings.push(`${channel}: document "${id}" is excluded by managedConfigurations and was skipped`);
        continue;
      }
      // Per-document tokens: the adapter's own conventional URLs (Walley's notificationUri/validationUri are exactly these).
      const derived = deriveUrls(catalog, environment.target, slug, id);
      const docScope: Scope = derived.adapter ? { ...scope, tokens: { ...scope.tokens, publicUrl: derived.adapter.publicUrl, internalUrl: derived.adapter.internalUrl } } : scope;
      const resolved = interpolateJson({ ...patch, id }, docScope, `${channel}/${id}`) as JsonObject;
      if (resolved.active === false && Object.keys(resolved).length <= 2) {
        // `active: false` alone is a legitimate way to park an adapter; keep it.
      }
      documents.push(sortKeys(applyDerived(catalog, environment.target, slug, resolved as Document)) as Document);
    }
    if (documents.length === 0) warnings.push(`${channel}: no documents produced (no layer matched)`);
    documents.sort((a, b) => a.id.localeCompare(b.id));
    channels.push({ env, target: environment.target, channel, spec, documents, sources });
  }
  return { env, target: environment.target, channels, warnings };
}

/** Flattens a JSON value into dotted leaf paths. Arrays and empty objects are kept as atoms. */
export function leaves(value: Json, prefix = ""): Map<string, Json> {
  const out = new Map<string, Json>();
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) {
      for (const [p, lv] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, lv);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}
