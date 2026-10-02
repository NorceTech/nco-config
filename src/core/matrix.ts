import type { ChannelSpec, NoccConfig, Selector } from "./types.js";
import { interpolateTokens } from "./interpolate.js";

/** True when every dimension listed in the selector matches the channel's value. */
export function matches(dims: Record<string, string>, selector: Selector): boolean {
  return Object.entries(selector).every(([dim, allowed]) => {
    const values = Array.isArray(allowed) ? allowed : [allowed];
    return dims[dim] !== undefined && values.includes(dims[dim]);
  });
}

function cartesian(dimensions: Record<string, string[]>): Record<string, string>[] {
  return Object.entries(dimensions).reduce<Record<string, string>[]>(
    (acc, [dim, values]) => acc.flatMap((row) => values.map((v) => ({ ...row, [dim]: v }))),
    [{}],
  );
}

/** Expands dimensions, exclusions, explicit channels and feature selectors into channel specs. */
export function expandChannels(config: NoccConfig): ChannelSpec[] {
  const dimensions = config.dimensions ?? {};
  const template = config.channelName ?? Object.keys(dimensions).map((d) => `\${${d}}`).join("-");
  const rows = Object.keys(dimensions).length > 0 ? cartesian(dimensions) : [];
  const excluded = config.exclude ?? [];

  const specs: ChannelSpec[] = [];
  for (const dims of rows) {
    if (excluded.some((sel) => matches(dims, sel))) continue;
    specs.push({ name: channelNameFor(template, dims, config.channelNameParts), dims, features: [] });
  }
  for (const [name, dims] of Object.entries(config.channels ?? {})) {
    if (specs.some((s) => s.name === name)) throw new Error(`channel "${name}" is both generated and declared explicitly`);
    specs.push({ name, dims: { ...dims }, features: [] });
  }

  for (const spec of specs) {
    // Selectors may also address the channel by its logical name: `{ channel: [se-walley, se-walley-ingrid] }`.
    const selectable = { ...spec.dims, channel: spec.name };
    for (const [feature, selection] of Object.entries(config.features ?? {})) {
      const selectors = selection === true ? [{}] : Array.isArray(selection) ? selection : [selection];
      if (selectors.some((sel) => matches(selectable, sel))) spec.features.push(feature);
    }
  }

  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.name)) throw new Error(`channel name "${s.name}" is produced more than once; make channelName include every dimension`);
    seen.add(s.name);
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Applies channelNameParts (value → fragment) before filling the template. */
export function channelNameFor(template: string, dims: Record<string, string>, parts?: NoccConfig["channelNameParts"]): string {
  const tokens: Record<string, string> = { ...dims };
  for (const [dim, map] of Object.entries(parts ?? {})) {
    if (dims[dim] !== undefined && map[dims[dim]] !== undefined) tokens[dim] = map[dims[dim]];
  }
  return interpolateTokens(template, tokens, "channelName");
}

/** Channel name as deployed in a given environment. */
export function deployedChannelName(spec: ChannelSpec, env: NoccConfig["environments"][string]): string {
  return `${env.channelPrefix ?? ""}${spec.name}${env.channelSuffix ?? ""}`;
}
