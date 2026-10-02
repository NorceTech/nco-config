import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Json, NoccConfig } from "./types.js";

export const CONFIG_FILE = "nco.yaml";

export class ConfigError extends Error {}

export interface Project {
  root: string;
  config: NoccConfig;
  lookups: Json;
}

function fail(msg: string): never {
  throw new ConfigError(`${CONFIG_FILE}: ${msg}`);
}

export function validateConfig(raw: unknown): NoccConfig {
  if (typeof raw !== "object" || raw === null) fail("must be a mapping");
  const c = raw as Record<string, unknown>;
  if (typeof c.merchant !== "string" || !c.merchant) fail("`merchant` is required");
  if (typeof c.environments !== "object" || c.environments === null || Object.keys(c.environments).length === 0) {
    fail("`environments` must list at least one environment");
  }
  for (const [name, env] of Object.entries(c.environments as Record<string, unknown>)) {
    if (typeof env !== "object" || env === null || typeof (env as { target?: unknown }).target !== "string") {
      fail(`environments.${name}.target is required (prod | stage | playground | test)`);
    }
    if (!/^[a-z0-9-]+$/.test(name)) fail(`environment name "${name}" must be lowercase letters, digits and hyphens`);
  }
  if (!Array.isArray(c.layers) || c.layers.length === 0) fail("`layers` must list at least one layer directory");
  if (c.dimensions !== undefined) {
    for (const [dim, values] of Object.entries(c.dimensions as Record<string, unknown>)) {
      if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) fail(`dimensions.${dim} must be a list of strings`);
      if (["env", "target", "channel", "merchant", "slug", "feature"].includes(dim)) fail(`dimension name "${dim}" is reserved`);
    }
  }
  return c as unknown as NoccConfig;
}

/** Finds nco.yaml in `start` or any parent directory. */
export function findProjectRoot(start = process.cwd()): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadProject(start = process.cwd()): Project {
  const root = findProjectRoot(start);
  if (!root) throw new ConfigError(`no ${CONFIG_FILE} found in ${start} or its parents (run \`nco init\`)`);
  const config = validateConfig(parseYaml(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8")));
  const lookupsFile = path.join(root, config.lookups ?? "lookups.yaml");
  const lookups: Json = fs.existsSync(lookupsFile) ? (parseYaml(fs.readFileSync(lookupsFile, "utf8")) as Json) ?? {} : {};
  return { root, config, lookups };
}

export function environmentOf(config: NoccConfig, env: string) {
  const e = config.environments[env];
  if (!e) throw new ConfigError(`unknown environment "${env}" (have: ${Object.keys(config.environments).join(", ")})`);
  return e;
}

/** Glob-ish match: `*` matches any run of characters. */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(value);
}

const DEFAULT_EXCLUDE = ["admin_meta", "admin_notifications", "checkout_application", "checkout_form_*", "checkout_layout_*", "checkout_meta_*"];

/** Whether a document id is owned by this repository. */
export function isManaged(config: NoccConfig, id: string): boolean {
  const include = config.managedConfigurations?.include ?? ["*"];
  const exclude = config.managedConfigurations?.exclude ?? DEFAULT_EXCLUDE;
  return include.some((p) => globMatch(p, id)) && !exclude.some((p) => globMatch(p, id));
}
