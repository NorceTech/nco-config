/** A configuration document as stored by the configuration service. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface Document extends JsonObject {
  id: string;
}

export interface EnvironmentConfig {
  /** Which deployed environment this maps to: prod | stage | playground | test. */
  target: string;
  /** Appended to every generated channel name in this environment (e.g. "-qa"). */
  channelSuffix?: string;
  /** Prepended to every generated channel name in this environment. */
  channelPrefix?: string;
  /** Values available as ${var:name} in this environment. Override global `vars`. */
  vars?: Record<string, string>;
  /** Override the configuration API base URL (default derived from slug + target). */
  apiBaseUrl?: string;
  /** Bearer token for the configuration API; normally "${secret:NOCC_TOKEN_<ENV>}". */
  token?: string;
}

/** Selects channels by dimension values; every listed dimension must match one of the values. */
export type Selector = Record<string, string | string[]>;

export interface NoccConfig {
  merchant: string;
  /** Public API host prefix, defaults to merchant. */
  slug?: string;
  environments: Record<string, EnvironmentConfig>;
  /** Dimension name → allowed values. Channels = cartesian product minus `exclude`. */
  dimensions?: Record<string, string[]>;
  /** Channel name template, e.g. "${brand}-${market}-${segment}". Default: dimensions joined with "-". */
  channelName?: string;
  /**
   * Name fragment per dimension value when it differs from the value itself, e.g.
   * `segment: { b2c: "", b2b: "-b2b" }` with channelName "${brand}-${market}${segment}".
   */
  channelNameParts?: Record<string, Record<string, string>>;
  /** Extra channels outside the matrix: name → dimension values. */
  channels?: Record<string, Record<string, string>>;
  /** Matrix combinations to drop. */
  exclude?: Selector[];
  /** Named features: feature → selector(s) of channels that get it, or `true` for all. */
  features?: Record<string, true | Selector | Selector[]>;
  /** Layer directories in merge order; may contain {dim}, {env}, {target}, {channel}, {feature}. */
  layers: string[];
  /** Global values available as ${var:name}. */
  vars?: Record<string, string>;
  /** Lookup tables file (default lookups.yaml), available as ${lookup:dotted.path}. */
  lookups?: string;
  secrets?: {
    /** Providers in order: env, dotenv. */
    providers?: string[];
    /** dotenv file template, default ".env.{env}". */
    dotenv?: string;
  };
  managedConfigurations?: {
    include?: string[];
    exclude?: string[];
  };
  /** Path to catalog file; default: the catalog shipped with the tool. */
  catalog?: string;
  /** Extra validation rules. */
  rules?: {
    /** Regex every channel name must match. */
    channelName?: string;
  };
}

export interface ChannelSpec {
  /** Base channel name (before environment prefix/suffix). */
  name: string;
  dims: Record<string, string>;
  features: string[];
}

export interface BuiltChannel {
  env: string;
  target: string;
  /** Channel name as it exists in the configuration service for this environment. */
  channel: string;
  spec: ChannelSpec;
  documents: Document[];
  /** Layer files that contributed, for diagnostics. */
  sources: string[];
}

export interface BuildResult {
  env: string;
  target: string;
  channels: BuiltChannel[];
  warnings: string[];
}
