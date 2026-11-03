import {
  AUTONOMY_LABEL,
  RUN_KIND_LABEL,
  acceptanceFor,
  driverLabel,
  followUpFor,
  lastMergeOutcome,
  lookoutsLabel,
  runCostLabel,
  runTokens,
  settingsLabel,
  visualReviewPending,
  visualReviewWaivedByPreApproval,
} from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import { screenshotPath } from "../../core/screenshots.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { allowCommand, postmortemCrewLabel, repoName } from "./shared.js";

export function registerShow(program: Command, ctx: CliContext): void {
  program
    .command("show")
    .description("Show a task: what it found and what it needs from you")
    .argument("<id>")
    .option("-e, --events", "show the full activity log")
    .action((id: string, opts: { events?: boolean }) => showTask(ctx, id, opts));
}

function showTask({ store }: CliContext, id: string, opts: { events?: boolean }): void {
  const m = store.getTask(id) ?? ui.fail(`No task ${id}`);
  const repo = m.repoId ? store.getRepo(m.repoId) : null;
  const goalId = store.goalForTask(m.id);
  if (goalId) console.log(`\n  Part of goal: crane goals show ${goalId}`);
  console.log(`\n${ui.statusDot(m.status)} ${pc.bold(m.title)}`);
  console.log(
    ui.dim(
      `  ${m.id} · ${ui.kindLabel(m)} · ${repoName(store, m.repoId) ?? "—"} · ${AUTONOMY_LABEL[m.autonomy]} · ${ui.ago(m.createdAt)}`,
    ),
  );
  const runs = store.listRuns(m.id);
  const cost = m.costUsd ? ` · ${ui.usd(m.costUsd)}${runs.length > 1 ? ` over ${runs.length} runs` : ""}` : "";
  const ran = store.lastWorkDriver(m.id);
  const agent = m.driver ?? ran;
  const on = agent && agent !== "unknown" ? ` · on ${driverLabel(agent)}` : "";
  const member = m.assignee ? store.listAgents().find((a) => a.id === m.assignee) : null;
  const reviewers = m.status === "queued" && m.postmortemOf ? store.postmortemCrew() : [];
  const forMember = member
    ? ` · for ${member.name}${m.status === "queued" && !member.active ? " (on-call)" : ""}`
    : reviewers.length ? ` · for ${postmortemCrewLabel(store, reviewers)}` : "";
  const preApproved = m.preApprovedAt && ["queued", "running"].includes(m.status) ? " · pre-approved" : "";
  console.log(`  ${ui.statusText(m.status)}${ui.dim(forMember + on + cost + preApproved)}`);
  if (m.branch) {
    console.log(`  Visual review: ${visualReviewWaivedByPreApproval(m) ? "waived by pre-approval" : m.visualReview?.status ?? "pending"}${m.visualReview ? ` · candidate ${m.visualReview.commit}` : ""}`);
    if (m.visualReview?.note) console.log(ui.wrap(m.visualReview.note, 2));
    if (visualReviewPending(m)) console.log(`  Record inspection: crane visual-review ${m.id} --commit <full-sha> -m 'views, sizes, screenshot paths' (or --waive with reason and scope)`);
  }
  if (settingsLabel(m)) console.log(ui.dim(`  Model settings: ${settingsLabel(m)}`));
  if (m.lookouts.length) console.log(ui.dim(`  Also looks for: ${lookoutsLabel(m.lookouts)}`));
  if (m.scheduledAt) console.log(ui.dim(`  Start no earlier than: ${new Date(m.scheduledAt).toLocaleString()} (${m.scheduledAt})`));
  const source = store.followUpSource(m);
  if (source) {
    console.log(`  ${ui.dim("Follow-up to")} ${source.id}  ${source.title}  ${ui.statusText(source.status)}`);
    if (source.finding) console.log(`  ${ui.dim("Finding")} ${source.finding}`);
  }

  const prerequisites = store.prerequisiteStates(m);
  const waiting = store.unmetPrerequisites(m);
  if (prerequisites.length) {
    const title = m.prerequisitesWaivedAt
      ? "Prerequisites, waived"
      : waiting.length && m.status === "queued" ? ui.accent("Waiting for prerequisites") : "Prerequisites";
    console.log(ui.section(title, prerequisites.length));
    for (const t of prerequisites) {
      console.log(`  ${t.met ? pc.green("✓") : ui.dim("○")} ${t.id}  ${t.title}  ${t.met ? ui.dim("landed") : ui.statusText(t.status)}`);
    }
  }
  if (m.acceptance.length) {
    console.log(ui.section("Acceptance criteria", m.acceptance.length));
    m.acceptance.forEach((c, i) => {
      const said = m.report ? acceptanceFor(m.report, c) : undefined;
      const mark = !m.report ? ui.dim(String(i + 1)) : said?.met ? pc.green("✓") : pc.red("✕");
      console.log(`  ${mark}  ${c}${m.report && !said ? ui.dim("  not reported") : ""}`);
      if (said?.evidence) console.log(ui.wrap(said.evidence, 5));
    });
  }

  if (m.report) {
    console.log(ui.section("Summary"));
    console.log(ui.wrap(m.report.summary, 2));
    if (m.report.screenshots?.length) {
      console.log(ui.section("Screenshots", m.report.screenshots.length));
      for (const image of m.report.screenshots) {
        const path = screenshotPath(m.id, image.path);
        if (path) console.log(`  ${image.caption}\n  ${ui.dim(path)}`);
      }
    }
    if (m.report.findings.length) {
      const followUps = store.followUps(m.id);
      console.log(ui.section("Findings", m.report.findings.length));
      m.report.findings.forEach((f, i) => {
        console.log(`  ${ui.accent(String(i + 1))}  ${pc.bold(f.title)}  ${ui.dim(`${f.impact} impact · ${f.effort} effort`)}`);
        console.log(ui.wrap(f.detail, 5));
        const next = followUpFor(followUps, i);
        if (next) console.log(`     ${ui.dim("Follow-up")} ${next.id}  ${ui.statusText(next.status)}`);
      });
    }
    if (m.report.changedFiles.length) {
      console.log(ui.section("Changed files", m.report.changedFiles.length));
      for (const f of m.report.changedFiles.slice(0, 12)) console.log(`  ${ui.dim("·")} ${f}`);
    }
  }

  if (opts.events && runs.length) {
    console.log(ui.section("Runs", runs.length));
    for (const r of runs) {
      const tokens = runTokens(r);
      console.log(
        `  ${RUN_KIND_LABEL[r.kind].padEnd(18)} ${runCostLabel(r, ui.usd).padStart(8)}  ${ui.dim(
          [r.outcome, r.driver === "unknown" ? null : driverLabel(r.driver), r.model, r.turns ? `${r.turns} turns` : null, tokens ? `${ui.compact(tokens)} tokens` : null, ui.ago(r.startedAt)]
            .filter(Boolean)
            .join(" · "),
        )}`,
      );
    }
  }

  const blocked = store.blockedTools({ taskId: m.id, ...(m.repoId ? { repoId: m.repoId } : {}) });
  if (blocked.length) {
    console.log(ui.section(ui.accent("Blocked"), blocked.length));
    for (const b of blocked) console.log(ui.blockedLine(b));
  }

  const events = store.listEvents(m.id);
  const shown = opts.events ? events : events.filter((e) => e.type !== "tool").slice(-6);
  console.log(ui.section("Activity", events.length));
  for (const e of shown) console.log("  " + ui.eventLine(e));
  if (!opts.events && events.length > shown.length) console.log(ui.dim(`  … crane show ${m.id} --events for all of it`));

  console.log("");
  const merge = lastMergeOutcome(events);
  const main = repo?.defaultBranch ?? "main";
  if (merge?.error) {
    console.log(`\n  ${pc.red("✕")} ${pc.bold(`Couldn't merge into ${main}`)}`);
    console.log(ui.wrap(merge.error, 4));
  }

  const next: [string, string][] = [];
  if (m.status === "needs_review") {
    next.push([`crane approve ${m.id}`, m.branch ? `merge into ${main} and push` : "mark as reviewed"]);
    if (m.branch) next.push([`crane approve ${m.id} --no-merge`, `approve only, keep ${m.branch}`]);
    next.push([`crane decline ${m.id}`, m.branch ? "discard the branch" : "dismiss"]);
    if (m.branch) next.push([`crane diff ${m.id}`, "see the changes"]);
    if (m.report?.findings.length && m.autonomy === "observe") next.push([`crane follow-up ${m.id} 1`, "act on finding 1"]);
  } else if (m.status === "running" || m.status === "queued") {
    if (m.status === "queued" && waiting.length) {
      next.push([`crane waive ${m.id} -m "…"`, `start it without ${waiting.map((t) => t.id).join(", ")}, accepting a reduced scope`]);
    }
    next.push([`crane watch ${m.id}`, "follow along live"]);
    if (m.status === "running" && m.branch) next.push([`crane diff ${m.id}`, "see the changes so far"]);
    next.push([`crane cancel ${m.id}`, "stop it"]);
    if (m.autonomy !== "observe") {
      next.push(m.preApprovedAt
        ? [`crane pre-approve ${m.id} --undo`, "wait for your review instead of merging"]
        : [`crane pre-approve ${m.id}`, `merge into ${main} once its checks pass`]);
    }
  } else if (m.status === "merging") {
    next.push([`crane watch ${m.id}`, "follow the merge"]);
  } else if (m.status === "failed" || m.status === "cancelled") {
    next.push([`crane retry ${m.id}`, "run it again"]);
  } else if ((m.status === "approved" || m.status === "done") && m.branch) {
    next.push([`crane merge ${m.id}`, `merge into ${main} and push`]);
  } else if (m.status === "merged" && merge?.checkoutBehind) {
    next.push([`git -C ${merge.checkoutBehind} pull --ff-only`, "catch your checkout up, once it's clean"]);
  }
  if (blocked[0]) next.push([allowCommand(blocked[0], m.id), `let agents run it in ${blocked[0].repoName}`]);
  if (next.length) console.log(ui.hint(...next) + "\n");
}
