import type { Command } from "commander";
import pc from "picocolors";
import { factoryState } from "../../factory/state.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { allowCommand, factoryLine, repoName } from "./shared.js";

/** `crane` with no arguments: the one screen you need. */
export function registerHome(program: Command, ctx: CliContext): void {
  program.action(() => showHome(ctx));
}

function showHome({ store }: CliContext): void {
  const o = store.overview(factoryState(store));
  const delta = o.shippedThisWeek - o.shippedLastWeek;
  const last24 = o.activity.slice(-24).map((b) => b.events + b.done * 5);

  console.log(`\n${ui.brand()}   ${factoryLine(store)}\n`);
  console.log(
    `  ${pc.bold(String(o.shippedThisWeek))} shipped this week  ${
      delta === 0 ? ui.dim("same as last week") : delta > 0 ? pc.green(`+${delta} vs last week`) : pc.red(`${delta} vs last week`)
    }`,
  );
  console.log(`  ${ui.sparkline(last24)}  ${ui.dim("activity, last 24h")}`);

  if (o.needsReview.length) {
    console.log(ui.section(ui.accent("Needs you"), o.needsReview.length));
    for (const m of o.needsReview.slice(0, 5)) console.log(ui.taskLine(m, repoName(store, m.repoId)));
  }
  if (o.goalsNeedingReview?.length) {
    console.log(ui.section(ui.accent("Goals needing you"), o.goalsNeedingReview.length));
    for (const g of o.goalsNeedingReview) console.log(`  ${g.id} · ${g.title} · crane goals show ${g.id}`);
  }
  if (o.inFlight.length) {
    console.log(ui.section("In flight", o.inFlight.length));
    for (const m of o.inFlight.slice(0, 5)) console.log(ui.taskLine(m, repoName(store, m.repoId)));
  }
  if (o.blocked.length) {
    console.log(ui.section(ui.accent("Blocked commands"), o.blocked.length));
    for (const b of o.blocked) console.log(ui.blockedLine(b));
  }
  if (!o.needsReview.length && !o.inFlight.length && !o.goalsNeedingReview?.length) {
    console.log(`\n  ${ui.dim("Nothing needs you and nothing is running.")}`);
  }

  console.log("");
  const next: [string, string][] = [];
  if (o.needsReview[0]) next.push([`crane show ${o.needsReview[0].id}`, "review the top item"]);
  if (o.blocked[0]) next.push([allowCommand(o.blocked[0]), `let agents run it in ${o.blocked[0].repoName}`]);
  next.push(['crane do "…"', "give the factory an instruction"]);
  if (!o.repos.some((r) => !r.isFactory)) next.push(["crane repos add <path>", "connect a codebase to work on"]);
  if (!o.factory.running) next.push(["crane serve", "start agents and open the dashboard"]);
  if (o.factory.factoryOutdated) next.push(["npm run build", "then restart the factory to load recent backend changes"]);
  else if (o.factory.uiOutdated) next.push(["npm run build -w web", "the dashboard is older than its source; Crane rebuilds it after merges, so run this if it stays"]);
  next.push(["crane help", "everything else"]);
  console.log(ui.hint(...next));
  console.log("");
}
