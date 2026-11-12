import {
  AUTONOMY_LABEL,
  RUN_KIND_LABEL,
  acceptanceCheckRun,
  acceptanceFor,
  actorLabel,
  driverLabel,
  followUpFor,
  lastMergeOutcome,
  lookoutsLabel,
  runCostLabel,
  runTokens,
  settingsLabel,
  visualReviewPending,
  visualReviewWaivedByPreApproval,
  type AgentRun,
  type BlockedTool,
  type MergeOutcome,
  type PrerequisiteState,
  type Task,
  type TaskEvent,
} from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import { screenshotPath } from "@crane/storage";
import type { Store } from "@crane/storage";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { nextSteps } from "./next-steps.js";
import { postmortemCrewLabel, repoName } from "./shared.js";

export function registerShow(program: Command, ctx: CliContext): void {
  program
    .command("show")
    .description("Show a task: what it found and what it needs from you")
    .argument("<id>")
    .option("-e, --events", "show the full activity log")
    .option("--json", "print the task, its runs, blocked commands and every event as JSON")
    .action((id: string, opts: { events?: boolean; json?: boolean }) => (opts.json ? showTaskJson(ctx, id) : showTask(ctx, id, opts)));
}

/** Everything `--events` shows, as records: what agents read to investigate a task. */
function showTaskJson({ store }: CliContext, id: string): void {
  const task = store.getTask(id) ?? ui.fail(`No task ${id}`);
  const blocked = store.blockedTools({ taskId: task.id, ...(task.repoId ? { repoId: task.repoId } : {}) });
  console.log(JSON.stringify({
    task,
    goal: store.goalForTask(task.id),
    prerequisites: store.prerequisiteStates(task),
    runs: store.listRuns(task.id),
    blocked,
    events: store.listEvents(task.id),
  }, null, 2));
}

function showTask({ store }: CliContext, id: string, opts: { events?: boolean }): void {
  const task = store.getTask(id) ?? ui.fail(`No task ${id}`);
  const all = opts.events ?? false;
  const runs = store.listRuns(task.id);
  const waiting = store.unmetPrerequisites(task);
  const blocked = store.blockedTools({ taskId: task.id, ...(task.repoId ? { repoId: task.repoId } : {}) });
  const events = store.listEvents(task.id);
  const merge = lastMergeOutcome(events);
  const main = (task.repoId ? store.getRepo(task.repoId) : null)?.defaultBranch ?? "main";
  const next = nextSteps(task, { main, waiting: waiting.map((t) => t.id), checkoutBehind: merge?.checkoutBehind, blocked: blocked[0] });
  console.log([
    ...headerLines(store, task, runs),
    ...visualReviewLines(task),
    ...detailLines(store, task),
    ...prerequisiteLines(task, store.prerequisiteStates(task), waiting.length > 0),
    ...acceptanceLines(task),
    ...acceptanceCheckLines(task),
    ...reportLines(store, task),
    ...(all ? runLines(runs) : []),
    ...blockedLines(blocked),
    ...activityLines(task.id, events, all),
    "",
    ...mergeErrorLines(merge, main),
    ...(next.length ? [ui.hint(...next) + "\n"] : []),
  ].join("\n"));
}

/** The goal it belongs to, its title, and one line each of identity and status. */
function headerLines(store: Store, task: Task, runs: AgentRun[]): string[] {
  const goalId = store.goalForTask(task.id);
  const agent = task.driver ?? store.lastWorkDriver(task.id);
  const on = agent && agent !== "unknown" ? ` · on ${driverLabel(agent)}` : "";
  const preApproved = task.preApprovedAt && ["queued", "running"].includes(task.status) ? " · pre-approved" : "";
  return [
    ...(goalId ? [`\n  Part of goal: crane goals show ${goalId}`] : []),
    `\n${ui.statusDot(task.status)} ${pc.bold(task.title)}`,
    ui.dim(`  ${task.id} · ${ui.kindLabel(task)} · ${repoName(store, task.repoId) ?? "—"} · ${AUTONOMY_LABEL[task.autonomy]} · ${ui.ago(task.createdAt)}`),
    `  ${ui.statusText(task.status)}${ui.dim(assigneeLabel(store, task) + on + costLabel(task, runs) + preApproved)}`,
  ];
}

/** " · for Hoist", or the post-mortem crew a queued post-mortem waits for. */
function assigneeLabel(store: Store, task: Task): string {
  const queued = task.status === "queued";
  const member = task.assignee ? store.listAgents().find((a) => a.id === task.assignee) : null;
  if (member) return ` · for ${member.name}${queued && !member.active ? " (on-call)" : ""}`;
  const reviewers = queued && task.postmortemOf ? store.postmortemCrew() : [];
  return reviewers.length ? ` · for ${postmortemCrewLabel(store, reviewers)}` : "";
}

function costLabel(task: Task, runs: AgentRun[]): string {
  if (!task.costUsd) return "";
  return ` · ${ui.usd(task.costUsd)}${runs.length > 1 ? ` over ${runs.length} runs` : ""}`;
}

/** Only tasks with a branch have a candidate to inspect. */
function visualReviewLines(task: Task): string[] {
  if (!task.branch) return [];
  const status = visualReviewWaivedByPreApproval(task) ? "waived by pre-approval" : task.visualReview?.status ?? "pending";
  const lines = [`  Visual review: ${status}${task.visualReview ? ` · candidate ${task.visualReview.commit}` : ""}`];
  if (task.visualReview?.note) lines.push(ui.wrap(task.visualReview.note, 2));
  if (visualReviewPending(task)) lines.push(`  Record inspection: crane visual-review ${task.id} --commit <full-sha> -m 'views, sizes, screenshot paths' (or --waive with reason and scope)`);
  return lines;
}

/** Model settings, look-outs, start time, and the finding it follows up. */
function detailLines(store: Store, task: Task): string[] {
  const lines: string[] = [];
  if (task.createdBy) lines.push(ui.dim(`  Started by ${actorLabel(task.createdBy)}`));
  const settings = settingsLabel(task);
  if (settings) lines.push(ui.dim(`  Model settings: ${settings}`));
  if (task.lookouts.length) lines.push(ui.dim(`  Also looks for: ${lookoutsLabel(task.lookouts)}`));
  if (task.scheduledAt) lines.push(ui.dim(`  Start no earlier than: ${new Date(task.scheduledAt).toLocaleString()} (${task.scheduledAt})`));
  const source = store.followUpSource(task);
  if (source) {
    lines.push(`  ${ui.dim("Follow-up to")} ${source.id}  ${source.title}  ${ui.statusText(source.status)}`);
    if (source.finding) lines.push(`  ${ui.dim("Finding")} ${source.finding}`);
  }
  return lines;
}

function prerequisiteLines(task: Task, prerequisites: PrerequisiteState[], waiting: boolean): string[] {
  if (!prerequisites.length) return [];
  return [
    ui.section(prerequisiteTitle(task, waiting), prerequisites.length),
    ...prerequisites.map((t) => `  ${t.met ? pc.green("✓") : ui.dim("○")} ${t.id}  ${t.title}  ${t.met ? ui.dim("landed") : ui.statusText(t.status)}`),
  ];
}

function prerequisiteTitle(task: Task, waiting: boolean): string {
  if (task.prerequisitesWaivedAt) return "Prerequisites, waived";
  return waiting && task.status === "queued" ? ui.accent("Waiting for prerequisites") : "Prerequisites";
}

/** Each criterion, with the agent's word on it once there's a report. */
function acceptanceLines(task: Task): string[] {
  if (!task.acceptance.length) return [];
  const lines = [ui.section("Acceptance criteria", task.acceptance.length)];
  task.acceptance.forEach((c, i) => {
    const said = task.report ? acceptanceFor(task.report, c) : undefined;
    lines.push(`  ${acceptanceMark(Boolean(task.report), said?.met, i)}  ${c}${task.report && !said ? ui.dim("  not reported") : ""}`);
    if (said?.evidence) lines.push(ui.wrap(said.evidence, 5));
  });
  return lines;
}

/** Its number before a report, then ✓ or ✕. */
function acceptanceMark(reported: boolean, met: boolean | undefined, index: number): string {
  if (!reported) return ui.dim(String(index + 1));
  return met ? pc.green("✓") : pc.red("✕");
}

/** Crane's own result for each required check, on this candidate. */
function acceptanceCheckLines(task: Task): string[] {
  if (!task.acceptanceChecks.length) return [];
  return [
    ui.section("Acceptance checks", task.acceptanceChecks.length),
    ...task.acceptanceChecks.map((command) => {
      const run = acceptanceCheckRun(task, command);
      if (!run) return `  ${ui.dim("○")}  ${command}  ${ui.dim("not run on this candidate")}`;
      const mark = run.status === "passed" ? pc.green("✓") : pc.red("✕");
      return `  ${mark}  ${command}  ${ui.dim(`${run.status} on ${run.commit.slice(0, 7)}`)}`;
    }),
  ];
}

/** The report: summary, screenshots, findings with their follow-ups, and changed files. */
function reportLines(store: Store, task: Task): string[] {
  const report = task.report;
  if (!report) return [];
  const lines = [ui.section("Summary"), ui.wrap(report.summary, 2)];
  if (report.screenshots?.length) {
    lines.push(ui.section("Screenshots", report.screenshots.length));
    for (const image of report.screenshots) {
      const path = screenshotPath(task.id, image.path);
      if (path) lines.push(`  ${image.caption}\n  ${ui.dim(path)}`);
    }
  }
  if (report.findings.length) {
    const followUps = store.followUps(task.id);
    lines.push(ui.section("Findings", report.findings.length));
    report.findings.forEach((f, i) => {
      lines.push(`  ${ui.accent(String(i + 1))}  ${pc.bold(f.title)}  ${ui.dim(`${f.impact} impact · ${f.effort} effort`)}`, ui.wrap(f.detail, 5));
      const next = followUpFor(followUps, i);
      if (next) lines.push(`     ${ui.dim("Follow-up")} ${next.id}  ${ui.statusText(next.status)}`);
    });
  }
  if (report.changedFiles.length) {
    lines.push(ui.section("Changed files", report.changedFiles.length));
    for (const f of report.changedFiles.slice(0, 12)) lines.push(`  ${ui.dim("·")} ${f}`);
  }
  return lines;
}

function runLines(runs: AgentRun[]): string[] {
  if (!runs.length) return [];
  return [ui.section("Runs", runs.length), ...runs.map((r) => {
    const tokens = runTokens(r);
    const facts = [r.outcome, r.driver === "unknown" ? null : driverLabel(r.driver), r.model, r.turns ? `${r.turns} turns` : null, tokens ? `${ui.compact(tokens)} tokens` : null, ui.ago(r.startedAt)];
    return `  ${RUN_KIND_LABEL[r.kind].padEnd(18)} ${runCostLabel(r, ui.usd).padStart(8)}  ${ui.dim(facts.filter(Boolean).join(" · "))}`;
  })];
}

function blockedLines(blocked: BlockedTool[]): string[] {
  if (!blocked.length) return [];
  return [ui.section(ui.accent("Blocked"), blocked.length), ...blocked.map((b) => ui.blockedLine(b))];
}

/** The last few events without tool calls, or every event with `--events`. */
function activityLines(taskId: string, events: TaskEvent[], all: boolean): string[] {
  const shown = all ? events : events.filter((e) => e.type !== "tool").slice(-6);
  const lines = [ui.section("Activity", events.length), ...shown.map((e) => "  " + ui.eventLine(e))];
  if (!all && events.length > shown.length) lines.push(ui.dim(`  … crane show ${taskId} --events for all of it`));
  return lines;
}

function mergeErrorLines(merge: MergeOutcome | null, main: string): string[] {
  if (!merge?.error) return [];
  return [`\n  ${pc.red("✕")} ${pc.bold(`Couldn't merge into ${main}`)}`, ui.wrap(merge.error, 4)];
}
