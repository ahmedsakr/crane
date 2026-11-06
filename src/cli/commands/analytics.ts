import { KIND_LABEL, driverLabel, type Analytics } from "@crane/contracts";
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

interface SpendRow { label: string; usd: number; tasks: number }

function showAnalytics({ store }: CliContext, opts: { days: string }): void {
  const a = store.analytics(Number(opts.days));
  const span = a.days === 1 ? "today" : `the last ${a.days} days`;
  console.log(`\n${ui.brand()}   Spend, ${span}\n`);
  if (!a.runs) {
    console.log(`  ${ui.dim(`No agent runs finished in ${span}.`)}\n`);
    console.log(ui.hint([`crane analytics --days ${a.days * 3}`, "look further back"]) + "\n");
    return;
  }
  console.log(headlineLines(a).join("\n"));
  const breakdowns: [string, SpendRow[]][] = [
    ["By agent", a.byAgent.map((r) => ({ label: driverLabel(r.driver), usd: r.usd, tasks: r.tasks }))],
    ["By repo", a.byRepo.map((r) => ({ label: r.name, usd: r.usd, tasks: r.tasks }))],
    ["By type", a.byKind.map((k) => ({ label: KIND_LABEL[k.kind], usd: k.usd, tasks: k.tasks }))],
  ];
  for (const [title, rows] of breakdowns) {
    if (!rows.length) continue;
    console.log(ui.section(title));
    console.log(tableLines(rows).join("\n"));
  }
  if (a.topTasks.length) {
    console.log(ui.section("Most expensive tasks"));
    for (const task of a.topTasks.slice(0, 5)) {
      console.log(`  ${ui.statusDot(task.status)} ${ui.dim(task.id)}  ${ui.truncate(task.title, 44).padEnd(44)}  ${ui.usd(task.usd).padStart(8)}`);
    }
  }
  console.log(
    `\n  ${ui.dim("Costs are what each agent reports, at API prices. On a subscription they're an estimate, not a bill. Codex reports tokens only, so its runs count as $0.")}\n`,
  );
  console.log(ui.hint(...analyticsHints(a)) + "\n");
}

/** How this window compares with the one before it. */
function comparedWithBefore(a: Analytics): string {
  const before = a.days === 1 ? "day" : `${a.days} days`;
  if (a.prevSpendUsd === 0) return `nothing in the ${before} before`;
  const delta = a.spendUsd - a.prevSpendUsd;
  return `${delta >= 0 ? "+" : "−"}${ui.usd(Math.abs(delta))} vs the ${before} before`;
}

/** Total spend, the daily sparkline, and the run and token facts under it. */
function headlineLines(a: Analytics): string[] {
  const maxDay = Math.max(...a.daily.map((d) => d.usd));
  const facts = [
    `${a.runs} runs across ${a.tasks} tasks`,
    a.shipped.tasks ? `${ui.usd(a.shipped.usd / a.shipped.tasks)} per shipped task` : null,
    a.unshipped.usd ? `${ui.usd(a.unshipped.usd)} on work that didn't ship` : null,
  ].filter(Boolean);
  const t = a.tokens;
  return [
    `  ${pc.bold(ui.usd(a.spendUsd))} spent  ${ui.dim(comparedWithBefore(a))}`,
    // Scale to whole numbers first: the sparkline floors its max at 1, which would flatten cents.
    `  ${ui.sparkline(a.daily.map((d) => (maxDay ? Math.round((d.usd / maxDay) * 100) : 0)))}  ${ui.dim("by day")}`,
    `  ${ui.dim(facts.join(" · "))}`,
    `  ${ui.dim(`${ui.compact(t.input + t.cacheRead + t.cacheWrite)} tokens in (${ui.compact(t.cacheRead)} from cache) · ${ui.compact(t.output)} out`)}`,
  ];
}

function tableLines(rows: SpendRow[]): string[] {
  const w = Math.min(32, Math.max(...rows.map((r) => r.label.length)));
  return rows.map((r) => `  ${ui.truncate(r.label, w).padEnd(w)}  ${ui.usd(r.usd).padStart(9)}  ${ui.dim(`${r.tasks} ${r.tasks === 1 ? "task" : "tasks"}`)}`);
}

function analyticsHints(a: Analytics): [string, string][] {
  const next: [string, string][] = [];
  if (a.topTasks[0]) next.push([`crane show ${a.topTasks[0].id}`, "see the most expensive task"]);
  const other = a.days === 7 ? 30 : 7;
  next.push([`crane analytics --days ${other}`, `see the last ${other} days`]);
  return next;
}
