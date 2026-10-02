import fs from "node:fs";
import path from "node:path";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import pc from "picocolors";
import type { Context } from "./context.js";
import { clientFor, resolverFor, primeSchemaSecrets } from "./context.js";
import { buildEnvironment } from "../core/build.js";
import { computePlan, hasChanges, type Plan } from "../core/plan.js";
import { conventionDiff, deriveUrls, schemaFetchUrl } from "../core/catalog.js";
import { environmentOf } from "../core/config.js";
import { expandChannels, deployedChannelName } from "../core/matrix.js";
import { factor, channelNameParser, type ExportChannel } from "../core/export.js";
import { replaceSecretLeaves, secretNameFor, CREDENTIAL_SHAPES } from "../secrets/detect.js";
import { findSecretRefs } from "../core/interpolate.js";
import type { Document, JsonObject, BuiltChannel } from "../core/types.js";
import { isObject, sortKeys } from "../core/mergePatch.js";
import { log, printPlan, planToJson } from "./output.js";

export class CommandError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- build

export interface BuildOpts {
  env?: string;
  channel?: string[];
  out?: string;
  quiet?: boolean;
}

export function runBuild(ctx: Context, opts: BuildOpts): BuiltChannel[] {
  const envs = opts.env ? [opts.env] : Object.keys(ctx.project.config.environments);
  const all: BuiltChannel[] = [];
  for (const env of envs) {
    const result = buildEnvironment(ctx.project, ctx.catalog, env, { channels: opts.channel });
    for (const w of result.warnings) log.warn(w);
    if (opts.out !== undefined) {
      const dir = path.join(opts.out, env);
      fs.rmSync(dir, { recursive: true, force: true });
      for (const ch of result.channels) {
        const cdir = path.join(dir, ch.channel);
        fs.mkdirSync(cdir, { recursive: true });
        for (const d of ch.documents) fs.writeFileSync(path.join(cdir, `${d.id}.json`), JSON.stringify(d, null, 2) + "\n");
      }
    }
    if (!opts.quiet) log.info(`${env}: ${result.channels.length} channels, ${result.channels.reduce((n, c) => n + c.documents.length, 0)} documents`);
    all.push(...result.channels);
  }
  return all;
}

// ---------------------------------------------------------------- validate

export async function runValidate(ctx: Context, opts: { env?: string; channel?: string[] }): Promise<number> {
  const channels = runBuild(ctx, { ...opts, quiet: true });
  let errors = 0;
  const rule = ctx.project.config.rules?.channelName ? new RegExp(ctx.project.config.rules.channelName) : undefined;
  for (const ch of channels) {
    if (rule && !rule.test(ch.channel)) {
      errors++;
      log.error(`${ch.env}/${ch.channel}: channel name does not match rules.channelName ${rule}`);
    }
    for (const doc of ch.documents) {
      let issues;
      try {
        issues = await ctx.schemas.validate(doc, schemaFetchUrl(ctx.catalog, ch.target, ctx.project.config.slug ?? ctx.project.config.merchant, doc));
      } catch (e) {
        errors++;
        log.error(`${ch.env}/${ch.channel}/${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      for (const i of issues) {
        errors++;
        log.error(`${ch.env}/${ch.channel}/${doc.id}: ${i.path} ${i.message}`);
      }
      for (const d of conventionDiff(ctx.catalog, ch.target, ctx.project.config.slug ?? ctx.project.config.merchant, doc)) {
        log.warn(`${ch.env}/${ch.channel}/${doc.id}: ${d} (explicit override, kept)`);
      }
      const unresolved = findSecretRefs(doc).filter((r) => !/^[A-Z0-9_]+$/.test(r.name));
      for (const r of unresolved) {
        errors++;
        log.error(`${ch.env}/${ch.channel}/${doc.id}: ${r.path} secret name "${r.name}" must be UPPER_SNAKE_CASE`);
      }
    }
  }
  if (errors) log.error(`${errors} problem(s)`);
  else log.ok(`valid: ${channels.length} channels, ${channels.reduce((n, c) => n + c.documents.length, 0)} documents`);
  return errors ? 1 : 0;
}

// ---------------------------------------------------------------- plan / apply

export interface PlanOpts {
  env: string;
  channel?: string[];
  json?: boolean;
  verbose?: boolean;
  allowDelete?: boolean;
}

export async function makePlan(ctx: Context, opts: PlanOpts): Promise<Plan> {
  const built = runBuild(ctx, { env: opts.env, channel: opts.channel, quiet: true });
  const resolver = resolverFor(ctx, opts.env);
  const client = clientFor(ctx, opts.env, resolver);
  const remoteChannels = await client.listChannels();
  const remote = new Map<string, Document[]>();
  const wanted = built.map((c) => c.channel);
  await Promise.all(
    wanted.map(async (c) => {
      if (remoteChannels.includes(c)) remote.set(c, await client.getDocuments(c));
    }),
  );
  await primeSchemaSecrets(ctx, new Map(built.flatMap((c) => c.documents.map((d) => [d.id, String(d.$schema)] as [string, string]))));
  return computePlan({ env: opts.env, built, remote, remoteChannels: opts.channel ? [] : remoteChannels, isManaged: ctx.isManaged, detector: ctx.detector, resolver });
}

export async function runPlan(ctx: Context, opts: PlanOpts): Promise<number> {
  const plan = await makePlan(ctx, opts);
  if (opts.json) console.log(JSON.stringify(planToJson(plan), null, 2));
  else printPlan(plan, { verbose: opts.verbose, allowDelete: opts.allowDelete });
  return hasChanges(plan) ? 2 : 0;
}

export async function runApply(ctx: Context, opts: PlanOpts & { yes?: boolean }): Promise<number> {
  const plan = await makePlan(ctx, opts);
  printPlan(plan, { allowDelete: opts.allowDelete });
  if (plan.unresolvedSecrets.length) {
    throw new CommandError(`refusing to apply with unresolved secrets: ${plan.unresolvedSecrets.join(", ")}`);
  }
  if (!hasChanges(plan)) {
    log.ok("nothing to apply");
    return 0;
  }
  if (!opts.yes) {
    const ok = await confirm(`Apply these changes to ${pc.bold(opts.env)} (merchant ${ctx.project.config.merchant})? [y/N] `);
    if (!ok) throw new CommandError("aborted", 1);
  }
  const resolver = resolverFor(ctx, opts.env);
  const client = clientFor(ctx, opts.env, resolver);
  const byChannel = new Map<string, Document[]>();
  const deletes: Array<{ channel: string; id: string }> = [];
  for (const c of plan.changes) {
    if ((c.kind === "create" || c.kind === "update") && c.desired) byChannel.set(c.channel, [...(byChannel.get(c.channel) ?? []), c.desired]);
    if (c.kind === "delete") deletes.push({ channel: c.channel, id: c.id });
  }
  for (const [channel, docs] of byChannel) {
    await client.putDocuments(channel, docs);
    log.ok(`${channel}: ${docs.length} document(s) written`);
  }
  if (deletes.length) {
    if (!opts.allowDelete) log.warn(`${deletes.length} deletion(s) skipped; re-run with --allow-delete to remove documents from the server`);
    else {
      for (const d of deletes) {
        await client.deleteDocument(d.channel, d.id);
        log.ok(`${d.channel}: ${d.id} deleted`);
      }
    }
  }
  return 0;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = await import("node:readline/promises");
  const i = rl.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await i.question(question)).trim().toLowerCase();
  i.close();
  return answer === "y" || answer === "yes";
}

// ---------------------------------------------------------------- export

export interface ExportOpts {
  env: string;
  channel?: string[];
  /** Write into this layer directory for base (default layers/base). */
  force?: boolean;
}

function writeYaml(file: string, value: JsonObject, header?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = toYaml(sortKeys(value), { lineWidth: 0 });
  fs.writeFileSync(file, (header ? `# ${header}\n` : "") + body);
}

/** Removes `$schema`, `adapter.*` and `active: true` when they equal the convention. */
function stripDerived(ctx: Context, target: string, doc: Document): JsonObject {
  const slug = ctx.project.config.slug ?? ctx.project.config.merchant;
  const derived = deriveUrls(ctx.catalog, target, slug, doc.id);
  const out: JsonObject = { ...doc };
  if (out.$schema === derived.schema) delete out.$schema;
  if (derived.adapter && isObject(out.adapter)) {
    const a: JsonObject = { ...out.adapter };
    if (a.internalUrl === derived.adapter.internalUrl) delete a.internalUrl;
    if (a.publicUrl === derived.adapter.publicUrl) delete a.publicUrl;
    if (Object.keys(a).length === 0) delete out.adapter;
    else out.adapter = a;
  }
  return out;
}

export async function runExport(ctx: Context, opts: ExportOpts): Promise<number> {
  const { config, root } = ctx.project;
  const environment = environmentOf(config, opts.env);
  const resolver = resolverFor(ctx, opts.env);
  const client = clientFor(ctx, opts.env, resolver);
  const dotenvFile = path.join(root, (config.secrets?.dotenv ?? ".env.{env}").replace("{env}", opts.env));
  assertIgnored(root, path.basename(dotenvFile));

  const remoteChannels = (await client.listChannels()).filter((c) => !opts.channel || opts.channel.includes(c));
  const dims = config.dimensions ?? {};
  const parse = Object.keys(dims).length ? channelNameParser(config.channelName ?? Object.keys(dims).map((d) => `\${${d}}`).join("-"), dims, config.channelNameParts) : undefined;
  const strip = (name: string) => {
    let n = name;
    if (environment.channelPrefix && n.startsWith(environment.channelPrefix)) n = n.slice(environment.channelPrefix.length);
    if (environment.channelSuffix && n.endsWith(environment.channelSuffix)) n = n.slice(0, -environment.channelSuffix.length);
    return n;
  };

  const channels: ExportChannel[] = [];
  const skipped: string[] = [];
  const secretValues = new Map<string, string>();
  const schemaUrls = new Map<string, string>();
  for (const remoteName of remoteChannels) {
    const base = strip(remoteName);
    const parsed = parse ? parse(base) : {};
    if (parsed === undefined) {
      skipped.push(remoteName);
      continue;
    }
    const docs = (await client.getDocuments(remoteName)).filter((d) => ctx.isManaged(d.id));
    if (docs.length === 0) {
      log.dim(`${remoteName}: only unmanaged documents (admin/layout) — not recorded`);
      continue;
    }
    for (const d of docs) if (typeof d.$schema === "string") schemaUrls.set(d.id, d.$schema);
    channels.push({ channel: base, dims: parsed, documents: docs });
  }
  await primeSchemaSecrets(ctx, schemaUrls);

  // Replace secrets with placeholders. Same value everywhere → one name; differing → suffixed by the channel.
  const valueNames = new Map<string, string>(); // `${id}|${path}|${value}` → name
  for (const ch of channels) {
    ch.documents = ch.documents.map((doc) => {
      const stripped = stripDerived(ctx, environment.target, doc) as Document;
      return replaceSecretLeaves(ctx.detector, stripped, (p, value) => {
        const key = `${doc.id}|${p}|${value}`;
        let name = valueNames.get(key);
        if (!name) {
          const plain = secretNameFor(doc.id, p);
          const taken = [...valueNames.values()].includes(plain);
          name = taken ? secretNameFor(doc.id, p, ch.channel) : plain;
          valueNames.set(key, name);
          secretValues.set(name, value);
        }
        return `\${secret:${name}}`;
      });
    });
  }

  const factored = factor(channels, Object.keys(dims));
  const written: string[] = [];
  const write = (rel: string, doc: JsonObject) => {
    const file = path.join(root, rel);
    if (fs.existsSync(file) && !opts.force) throw new CommandError(`${rel} exists; re-run with --force to overwrite exported files`);
    writeYaml(file, doc);
    written.push(rel);
  };
  for (const [id, patch] of factored.base) write(`layers/base/${id}.yaml`, { id, ...patch });
  for (const [id, patch] of factored.features) write(`layers/features/${id}/${id}.yaml`, { id, ...patch });
  for (const [dim, byValue] of factored.perDimension) {
    for (const [value, docs] of byValue) for (const [id, patch] of docs) write(`layers/${dim}/${value}/${id}.yaml`, { id, ...patch });
  }
  for (const [channel, docs] of factored.perChannel) {
    for (const [id, patch] of docs) write(`channels/${channel}/${id}.yaml`, { id, ...patch });
  }

  if (secretValues.size) {
    const existing = fs.existsSync(dotenvFile) ? fs.readFileSync(dotenvFile, "utf8") : "";
    const lines = [...secretValues].filter(([n]) => !new RegExp(`^${n}=`, "m").test(existing)).map(([n, v]) => `${n}=${JSON.stringify(v)}`);
    if (lines.length) fs.appendFileSync(dotenvFile, (existing && !existing.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
  }

  log.ok(`exported ${channels.length} channels into ${written.length} files; ${secretValues.size} secret(s) written to ${path.basename(dotenvFile)} (gitignored)`);
  if (!parse) log.info("no dimensions declared: everything that differs between channels went to channels/<name>/; declare dimensions + channelName in nco.yaml and re-export with --force to factor by dimension");
  for (const n of factored.notes) log.dim(`note: ${n}`);
  if (skipped.length) log.warn(`${skipped.length} channel(s) did not match channelName and were skipped: ${skipped.join(", ")}`);
  // Record what the layers alone cannot express in nco.yaml: the channel list (when no dimensions generate it)
  // and which channels carry each feature document.
  const configFile = path.join(root, "nco.yaml");
  const additions: Record<string, unknown> = {};
  if (!parse) {
    const known = new Set(Object.keys(config.channels ?? {}));
    const missing = channels.map((c) => c.channel).filter((c) => !known.has(c));
    if (missing.length) additions.channels = { ...(config.channels ?? {}), ...Object.fromEntries(missing.map((c) => [c, {}])) };
  }
  if (factored.featureChannels.size) {
    const features: Record<string, unknown> = { ...(config.features ?? {}) };
    for (const [id, list] of factored.featureChannels) features[id] = { channel: list };
    additions.features = features;
    if (!config.layers.some((l) => l.includes("${feature}"))) {
      additions.layers = [...config.layers.slice(0, 1), "layers/features/${feature}", ...config.layers.slice(1)];
      log.warn("added `layers/features/${feature}` to layers in nco.yaml (feature documents need it)");
    }
  }
  if (Object.keys(additions).length) {
    let text = fs.readFileSync(configFile, "utf8");
    for (const key of Object.keys(additions)) text = removeTopLevelKey(text, key);
    text = text.replace(/\s*$/, "\n") + "\n# --- recorded by `nco export`; feature selectors can be rewritten in terms of dimensions ---\n" + toYaml(additions, { lineWidth: 0 });
    fs.writeFileSync(configFile, text);
    log.info(`updated nco.yaml: ${Object.keys(additions).join(", ")}`);
  }
  return 0;
}

/** Removes a top-level YAML key and its indented block (used before re-writing it). */
function removeTopLevelKey(text: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (new RegExp(`^${key}:`).test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && (/^\s+\S/.test(line) || line.trim() === "" || line.startsWith("  #"))) continue;
    skipping = false;
    out.push(line);
  }
  return out.join("\n");
}

function assertIgnored(root: string, file: string): void {
  const gi = path.join(root, ".gitignore");
  const text = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const patterns = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ok = patterns.some((p) => p === file || p === ".env*" || p === ".env.*" || (p.endsWith("*") && file.startsWith(p.slice(0, -1))));
  if (!ok) throw new CommandError(`${file} is not listed in .gitignore; refusing to write secrets there. Add ".env.*" to .gitignore first.`);
}

// ---------------------------------------------------------------- secrets check

export function runSecretsCheck(ctx: Context, opts: { env?: string }): number {
  const { root, config } = ctx.project;
  let problems = 0;
  // 1. Every ${secret:} reference resolvable in each environment.
  for (const env of opts.env ? [opts.env] : Object.keys(config.environments)) {
    const resolver = resolverFor(ctx, env);
    const built = runBuild(ctx, { env, quiet: true });
    const names = new Set(built.flatMap((c) => c.documents.flatMap((d) => findSecretRefs(d).map((r) => r.name))));
    const missing = [...names].filter((n) => resolver.get(n) === undefined).sort();
    if (missing.length) {
      problems += missing.length;
      log.error(`${env}: ${missing.length} unresolved secret(s) via ${resolver.describe()}: ${missing.join(", ")}`);
    } else log.ok(`${env}: ${names.size} secret reference(s) resolvable`);
  }
  // 2. No credential-shaped strings in tracked files.
  const tracked = listTracked(root);
  for (const rel of tracked) {
    if (/^(\.env|.*\.(png|jpg|gif|ico|woff2?|lock))/.test(rel)) continue;
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const shape of CREDENTIAL_SHAPES) {
      const m = shape.re.exec(text);
      if (m && !/\$\{secret:/.test(m[0])) {
        problems++;
        log.error(`${rel}: contains a ${shape.name}-shaped string (${m[0].slice(0, 6)}…); move it to a secret`);
        break;
      }
    }
  }
  if (!problems) log.ok(`no credential-shaped strings in ${tracked.length} tracked files`);
  return problems ? 1 : 0;
}

function listTracked(root: string): string[] {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", ".nco", "dist"].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(path.relative(root, p));
      }
    };
    walk(root);
    return out;
  }
}

// ---------------------------------------------------------------- init

export function runInit(dir: string, answers: { merchant: string; slug?: string; environments: string[]; template?: boolean }): void {
  const file = path.join(dir, "nco.yaml");
  if (fs.existsSync(file)) throw new CommandError("nco.yaml already exists");
  const environments: Record<string, unknown> = {};
  for (const e of answers.environments) environments[e] = { target: e === "qa" || e === "local" ? "stage" : e, ...(e === "qa" ? { channelSuffix: "-qa" } : {}), ...(e === "local" ? { channelSuffix: "-local" } : {}) };
  const config = {
    merchant: answers.merchant,
    ...(answers.slug && answers.slug !== answers.merchant ? { slug: answers.slug } : {}),
    environments,
    dimensions: {},
    channelName: "",
    layers: ["layers/base", "layers/features/${feature}", "layers/target/${target}", "layers/env/${env}", "channels/${channel}", "channels/${channel}/${env}"],
    secrets: { providers: ["env", "dotenv"] },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `# yaml-language-server: $schema=https://raw.githubusercontent.com/norce/nco-config/main/schemas/nco.schema.json\n` +
      toYaml(config, { lineWidth: 0 }).replace("dimensions: {}", "# dimensions:\n#   market: [se, no]\n#   segment: [b2c, b2b]").replace('channelName: ""', '# channelName: "${market}-${segment}"'),
  );
  const gi = path.join(dir, ".gitignore");
  const want = ["node_modules/", ".nco/", ".env", ".env.*", "!.env.example"];
  const have = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8").split(/\r?\n/) : [];
  fs.writeFileSync(gi, [...have.filter(Boolean), ...want.filter((w) => !have.includes(w))].join("\n") + "\n");
  for (const e of answers.environments) {
    fs.writeFileSync(path.join(dir, `.env.${e}.example`), `# copy to .env.${e} (gitignored) and fill in\nNCO_TOKEN_${e.toUpperCase()}=\n`);
  }
  fs.mkdirSync(path.join(dir, "layers", "base"), { recursive: true });
  for (const e of answers.environments) fs.mkdirSync(path.join(dir, "layers", "env", e), { recursive: true });
  fs.mkdirSync(path.join(dir, "channels"), { recursive: true });
  log.ok(`created nco.yaml, .gitignore, .env.<env>.example and layer folders in ${dir}`);
  log.info(`next: fill .env.${answers.environments[0]} with NCO_TOKEN_${answers.environments[0].toUpperCase()} and run \`nco export --env ${answers.environments[0]}\``);
}

export function readYamlFile(file: string): JsonObject {
  return parseYaml(fs.readFileSync(file, "utf8")) as JsonObject;
}
