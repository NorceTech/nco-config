import pc from "picocolors";
import type { Plan, DocumentChange } from "../core/plan.js";
import { displayValue, summarise } from "../core/plan.js";

export const log = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(pc.green(msg)),
  warn: (msg: string) => console.error(pc.yellow(`warning: ${msg}`)),
  error: (msg: string) => console.error(pc.red(`error: ${msg}`)),
  dim: (msg: string) => console.log(pc.dim(msg)),
};

const KIND_LABEL: Record<DocumentChange["kind"], string> = {
  create: pc.green("+ create"),
  update: pc.yellow("~ update"),
  delete: pc.red("- delete"),
  unchanged: pc.dim("  unchanged"),
  unmanaged: pc.dim("  unmanaged"),
};

export function printPlan(plan: Plan, opts: { verbose?: boolean; allowDelete?: boolean } = {}): void {
  const byChannel = new Map<string, DocumentChange[]>();
  for (const c of plan.changes) byChannel.set(c.channel, [...(byChannel.get(c.channel) ?? []), c]);

  for (const [channel, changes] of [...byChannel].sort(([a], [b]) => a.localeCompare(b))) {
    const interesting = changes.filter((c) => c.kind !== "unchanged" && (opts.verbose || c.kind !== "unmanaged"));
    if (interesting.length === 0 && !opts.verbose) continue;
    console.log(pc.bold(channel));
    for (const c of opts.verbose ? changes : interesting) {
      let label = KIND_LABEL[c.kind];
      if (c.kind === "delete" && !opts.allowDelete) label += pc.dim(" (skipped without --allow-delete)");
      console.log(`  ${label} ${c.id}`);
      if (c.kind === "update" || (opts.verbose && c.kind !== "unmanaged")) {
        for (const f of c.fields) {
          console.log(`      ${pc.cyan(f.path)}: ${displayValue(f.from, f.secret)} ${pc.dim("→")} ${displayValue(f.to, f.secret)}`);
        }
      }
    }
  }
  if (plan.unknownChannels.length) {
    console.log(pc.bold("channels on the server that this repository does not produce") + pc.dim(" (never touched)"));
    for (const c of plan.unknownChannels) console.log(`  ${pc.dim("?")} ${c}`);
  }
  if (plan.unresolvedSecrets.length) {
    log.warn(`unresolved secrets (compared as placeholders): ${plan.unresolvedSecrets.join(", ")}`);
  }
  const s = summarise(plan);
  console.log(
    `\n${pc.bold("Plan:")} ${pc.green(`${s.create} to create`)}, ${pc.yellow(`${s.update} to update`)}, ${pc.red(`${s.delete} to delete`)}, ${s.unchanged} unchanged, ${s.unmanaged} unmanaged, ${s.unknownChannels} unknown channels`,
  );
}

export function planToJson(plan: Plan) {
  return {
    env: plan.env,
    summary: summarise(plan),
    unknownChannels: plan.unknownChannels,
    unresolvedSecrets: plan.unresolvedSecrets,
    changes: plan.changes
      .filter((c) => c.kind !== "unchanged")
      .map((c) => ({
        channel: c.channel,
        id: c.id,
        kind: c.kind,
        fields: c.fields.map((f) => ({ path: f.path, from: f.secret ? displayValue(f.from, true) : f.from, to: f.secret ? displayValue(f.to, true) : f.to })),
      })),
  };
}
