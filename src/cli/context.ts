import path from "node:path";
import { loadProject, environmentOf, isManaged, type Project } from "../core/config.js";
import { loadCatalog, targetUrls, type Catalog } from "../core/catalog.js";
import { SchemaStore } from "../core/schema.js";
import { SecretDetector } from "../secrets/detect.js";
import { buildResolver, type SecretResolver } from "../secrets/providers.js";
import { ConfigurationClient } from "../api/client.js";
import { interpolateTokens } from "../core/interpolate.js";

export interface Context {
  project: Project;
  catalog: Catalog;
  schemas: SchemaStore;
  detector: SecretDetector;
  isManaged: (id: string) => boolean;
}

export interface GlobalOptions {
  cwd?: string;
  offline?: boolean;
  refreshSchemas?: boolean;
}

export function createContext(opts: GlobalOptions = {}): Context {
  const project = loadProject(opts.cwd);
  const catalog = loadCatalog(project.config.catalog ? path.resolve(project.root, project.config.catalog) : undefined);
  const schemas = new SchemaStore(path.join(project.root, ".nco", "cache", "schemas"), fetch, opts.offline ?? false);
  const schemaSecretCache = new Map<string, string[]>();
  const detector = new SecretDetector(catalog, (id) => schemaSecretCache.get(id) ?? []);
  return {
    project,
    catalog,
    schemas,
    detector,
    isManaged: (id) => isManaged(project.config, id),
  };
}

/** Loads schema-declared secret paths for the given documents into the detector (best effort). */
export async function primeSchemaSecrets(ctx: Context, schemaUrlsById: Map<string, string>): Promise<void> {
  // The detector reads from the cache map closed over in createContext; rebuild it here.
  const paths = new Map<string, string[]>();
  for (const [id, url] of schemaUrlsById) {
    try {
      paths.set(id, await ctx.schemas.secretPaths(url));
    } catch {
      /* schema unavailable: fall back to catalog + heuristics */
    }
  }
  (ctx as unknown as { detector: SecretDetector }).detector = new SecretDetector(ctx.catalog, (id) => paths.get(id) ?? []);
}

export function resolverFor(ctx: Context, env: string): SecretResolver {
  const s = ctx.project.config.secrets ?? {};
  return buildResolver(ctx.project.root, env, s.providers, s.dotenv);
}

export function clientFor(ctx: Context, env: string, resolver: SecretResolver): ConfigurationClient {
  const { config } = ctx.project;
  const environment = environmentOf(config, env);
  const slug = config.slug ?? config.merchant;
  const baseUrl = environment.apiBaseUrl ?? interpolateTokens(targetUrls(ctx.catalog, environment.target).configuration, { slug }, "catalog");
  let token: string | undefined;
  const configured = environment.token ?? `\${secret:NCO_TOKEN_${env.toUpperCase().replace(/[^A-Z0-9]/g, "_")}}`;
  const m = /^\$\{secret:([^}]+)\}$/.exec(configured);
  token = m ? resolver.get(m[1]) : configured;
  if (!token && environment.token !== undefined && environment.token !== "") {
    throw new Error(`token for environment "${env}" (${configured}) could not be resolved via ${resolver.describe()}`);
  }
  return new ConfigurationClient({ baseUrl, merchant: config.merchant, token });
}
