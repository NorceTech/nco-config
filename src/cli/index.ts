#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "./context.js";
import { CommandError, runApply, runBuild, runExport, runInit, runPlan, runSecretsCheck, runValidate } from "./commands.js";
import { ConfigError } from "../core/config.js";
import { InterpolationError } from "../core/interpolate.js";
import { ApiError } from "../api/client.js";
import { log } from "./output.js";

const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")) as { version: string };

const program = new Command()
  .name("nco")
  .description("Norce Checkout configuration as code: build, validate, plan and apply channel configurations from git.")
  .version(pkg.version)
  .option("-C, --cwd <dir>", "project directory (default: nearest nco.yaml)")
  .option("--offline", "use cached schemas only");

const list = (v: string, prev: string[] = []) => [...prev, v];

program
  .command("init")
  .description("create nco.yaml and the folder layout in the current directory")
  .requiredOption("--merchant <merchant>", "merchant identifier")
  .option("--slug <slug>", "public API host prefix if different from merchant")
  .option("--env <env>", "environment to configure (repeatable; default: stage, prod)", list)
  .action((o: { merchant: string; slug?: string; env?: string[] }) => {
    runInit(path.resolve(program.opts().cwd ?? "."), { merchant: o.merchant, slug: o.slug, environments: o.env ?? ["stage", "prod"] });
  });

program
  .command("build")
  .description("render final documents (secrets stay as placeholders)")
  .option("-e, --env <env>", "environment (default: all)")
  .option("-c, --channel <name>", "deployed channel name (repeatable)", list)
  .option("-o, --out <dir>", "write rendered JSON here", ".nco/build")
  .action((o) => {
    runBuild(createContext(program.opts()), o);
  });

program
  .command("validate")
  .description("validate rendered documents against their JSON schemas and project rules")
  .option("-e, --env <env>")
  .option("-c, --channel <name>", "repeatable", list)
  .action(async (o) => {
    process.exitCode = await runValidate(createContext(program.opts()), o);
  });

program
  .command("plan")
  .description("diff rendered documents against the configuration service (exit 2 when changes exist)")
  .requiredOption("-e, --env <env>")
  .option("-c, --channel <name>", "repeatable", list)
  .option("--json", "machine-readable output")
  .option("-v, --verbose", "include unchanged and unmanaged documents")
  .option("--allow-delete", "show deletions as applicable")
  .action(async (o) => {
    process.exitCode = await runPlan(createContext(program.opts()), o);
  });

program
  .command("drift")
  .description("alias for plan; intended for scheduled CI runs")
  .requiredOption("-e, --env <env>")
  .option("--json")
  .action(async (o) => {
    process.exitCode = await runPlan(createContext(program.opts()), o);
  });

program
  .command("apply")
  .description("write changed documents to the configuration service")
  .requiredOption("-e, --env <env>")
  .option("-c, --channel <name>", "repeatable", list)
  .option("-y, --yes", "do not ask for confirmation")
  .option("--allow-delete", "delete documents that exist on the server but not in this repository")
  .action(async (o) => {
    process.exitCode = await runApply(createContext(program.opts()), o);
  });

program
  .command("export")
  .description("pull live channels and factor them into layers; secrets go to .env.<env>")
  .requiredOption("-e, --env <env>")
  .option("-c, --channel <name>", "repeatable", list)
  .option("-f, --force", "overwrite existing layer files")
  .action(async (o) => {
    process.exitCode = await runExport(createContext(program.opts()), o);
  });

const secrets = program.command("secrets").description("secret hygiene");
secrets
  .command("check")
  .description("verify every ${secret:} is resolvable and no credential-shaped strings are tracked")
  .option("-e, --env <env>")
  .action((o) => {
    process.exitCode = runSecretsCheck(createContext(program.opts()), o);
  });

program
  .command("schema")
  .description("refresh cached JSON schemas")
  .action(async () => {
    const ctx = createContext({ ...program.opts(), refreshSchemas: true });
    const built = runBuild(ctx, { quiet: true });
    const urls = new Set(built.flatMap((c) => c.documents.map((d) => String(d.$schema))));
    for (const u of urls) {
      await ctx.schemas.get(u, true);
      log.info(`cached ${u}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommandError) {
    log.error(err.message);
    process.exitCode = err.exitCode;
  } else if (err instanceof ConfigError || err instanceof InterpolationError || err instanceof ApiError) {
    log.error(err.message);
    process.exitCode = 1;
  } else {
    log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
});
