import { KIND_LABEL, driverLabel } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";

/** `crane analytics`: what the factory costs. */
export function registerAnalytics(program: Command, ctx: CliContext): void {
  program
    .command("analytics")
    .alias("spend")
    .description("What the factory spent, by day, agent, repo, type, and task")
    .option("-d, --days <n>", "how many days back, today included", "30")
    .action((opts: { days: string }) => showAnalytics(ctx, opts));
}

function showAnalytics({ store }: CliContext, opts: { days: string }): void {
  const a = store.analytics(Number(opts.days));
  const span = a.days === 1 ? "today" : `the last ${a.days} days`;
  console.log(`\n${ui.brand()}   Spend, ${span}\n`);
  if (!a.runs) {
    console.log(`  ${ui.dim(`No agent runs finished in ${span}.`)}\n`);
    console.log(ui.hint([`crane analytics --days ${a.days * 3}`, "look further back"]) + "\n");
    return;
  }
  const delta = a.spendUsd - a.prevSpendUsd;
  const before = a.days === 1 ? "day" : `${a.days} days`;
  const vs = ui.dim(
    a.prevSpendUsd === 0
      ? `nothing in the ${before} before`
      : `${delta >= 0 ? "+" : "−"}${ui.usd(Math.abs(delta))} vs the ${before} before`,
  );
  console.log(`  ${pc.bold(ui.usd(a.spendUsd))} spent  ${vs}`);
  const maxDay = Math.max(...a.daily.map((d) => d.usd));
  // Scale to whole numbers first: the sparkline floors its max at 1, which would flatten cents.
  console.log(`  ${ui.sparkline(a.daily.map((d) => (maxDay ? Math.round((d.usd / maxDay) * 100) : 0)))}  ${ui.dim("by day")}`);
  const facts = [
    `${a.runs} runs across ${a.tasks} tasks`,
    a.shipped.tasks ? `${ui.usd(a.shipped.usd / a.shipped.tasks)} per shipped task` : null,
    a.unshipped.usd ? `${ui.usd(a.unshipped.usd)} on work that didn't ship` : null,
  ].filter(Boolean);
  console.log(`  ${ui.dim(facts.join(" · "))}`);
  const t = a.tokens;
  console.log(
    `  ${ui.dim(`${ui.compact(t.input + t.cacheRead + t.cacheWrite)} tokens in (${ui.compact(t.cacheRead)} from cache) · ${ui.compact(t.output)} out`)}`,
  );

  const table = (rows: { label: string; usd: number; tasks: number }[]) => {
    const w = Math.min(32, Math.max(...rows.map((r) => r.label.length)));
    for (const r of rows) {
      console.log(`  ${ui.truncate(r.label, w).padEnd(w)}  ${ui.usd(r.usd).padStart(9)}  ${ui.dim(`${r.tasks} ${r.tasks === 1 ? "task" : "tasks"}`)}`);
    }
  };
  if (a.byAgent.length) {
    console.log(ui.section("By agent"));
    table(a.byAgent.map((r) => ({ label: driverLabel(r.driver), usd: r.usd, tasks: r.tasks })));
  }
  if (a.byRepo.length) {
    console.log(ui.section("By repo"));
    table(a.byRepo.map((r) => ({ label: r.name, usd: r.usd, tasks: r.tasks })));
  }
  if (a.byKind.length) {
    console.log(ui.section("By type"));
    table(a.byKind.map((k) => ({ label: KIND_LABEL[k.kind], usd: k.usd, tasks: k.tasks })));
  }
  if (a.topTasks.length) {
    console.log(ui.section("Most expensive tasks"));
    for (const m of a.topTasks.slice(0, 5)) {
      console.log(`  ${ui.statusDot(m.status)} ${ui.dim(m.id)}  ${ui.truncate(m.title, 44).padEnd(44)}  ${ui.usd(m.usd).padStart(8)}`);
    }
  }
  console.log(
    `\n  ${ui.dim("Costs are what each agent reports, at API prices. On a subscription they're an estimate, not a bill. Codex reports tokens only, so its runs count as $0.")}\n`,
  );
  const next: [string, string][] = [];
  if (a.topTasks[0]) next.push([`crane show ${a.topTasks[0].id}`, "see the most expensive task"]);
  next.push([`crane analytics --days ${a.days === 7 ? 30 : 7}`, `see the last ${a.days === 7 ? 30 : 7} days`]);
  console.log(ui.hint(...next) + "\n");
}
