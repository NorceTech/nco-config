import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export interface SecretProvider {
  name: string;
  get(name: string): string | undefined;
}

export function envProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  return { name: "env", get: (n) => env[n] };
}

export function dotenvProvider(file: string): SecretProvider {
  const values = fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file, "utf8")) : {};
  return { name: `dotenv:${path.basename(file)}`, get: (n) => values[n] };
}

export class SecretResolutionError extends Error {
  constructor(readonly missing: string[]) {
    super(`unresolved secrets: ${missing.join(", ")}`);
  }
}

/** First provider that has the name wins. */
export class SecretResolver {
  constructor(private readonly providers: SecretProvider[]) {}

  get(name: string): string | undefined {
    for (const p of this.providers) {
      const v = p.get(name);
      if (v !== undefined && v !== "") return v;
    }
    return undefined;
  }

  /** Resolves every name or throws listing all missing names. */
  require(names: Iterable<string>): Map<string, string> {
    const out = new Map<string, string>();
    const missing: string[] = [];
    for (const n of new Set(names)) {
      const v = this.get(n);
      if (v === undefined) missing.push(n);
      else out.set(n, v);
    }
    if (missing.length) throw new SecretResolutionError(missing.sort());
    return out;
  }

  describe(): string {
    return this.providers.map((p) => p.name).join(" → ");
  }
}

export function buildResolver(root: string, env: string, providers: string[] = ["env", "dotenv"], dotenvTemplate = ".env.{env}"): SecretResolver {
  const list: SecretProvider[] = [];
  for (const p of providers) {
    if (p === "env") list.push(envProvider());
    else if (p === "dotenv") {
      list.push(dotenvProvider(path.join(root, dotenvTemplate.replace("{env}", env))));
      list.push(dotenvProvider(path.join(root, ".env")));
    } else throw new Error(`unknown secret provider "${p}" (supported: env, dotenv)`);
  }
  return new SecretResolver(list);
}
