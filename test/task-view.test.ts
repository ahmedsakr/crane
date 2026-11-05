import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_STATUSES, type Agent, type AgentRun, type Task, type TaskDetail, type TaskEvent, type TaskStatus } from "@crane/contracts";
import {
  addLiveEvent,
  canStartFollowUp,
  changesFor,
  decisionHeading,
  decisionText,
  driverName,
  groupEvents,
  isWorking,
  mergingSummary,
  pendingSummary,
  preApprovalText,
  prerequisitesText,
  runOutcomeLabel,
  scheduleOrigin,
  showsRuns,
  taskView,
  uniqueEvents,
  usedDriver,
  visualReviewHeading,
  visualReviewText,
  waitingOn,
} from "../web/src/pages/task/task-view.ts";

const baseTask = {
  id: "t-1",
  status: "queued",
  autonomy: "propose",
  branch: null,
  driver: null,
  assignee: null,
  postmortemOf: null,
  scheduledAt: null,
  scheduleId: null,
  prerequisitesWaivedAt: null,
  preApprovedAt: null,
  visualReview: null,
  report: null,
  acceptance: [],
  acceptanceChecks: [],
};
const makeTask = (over: Record<string, unknown> = {}) => ({ ...baseTask, ...over }) as unknown as Task;
const agent = (name: string, active: boolean) => ({ name, active }) as Pick<Agent, "name" | "active">;
const noContext = { agent: null, waitingOn: [], postmortemCrew: [] };
const event = (id: number, type: string, message = `e${id}`) => ({ id, type, message, ts: "2026-01-01T00:00:00Z" }) as unknown as TaskEvent;
const prerequisite = (id: string, met: boolean) => ({ id, title: id, status: met ? "merged" : "running", met });

const PENDING_TEXT: Partial<Record<TaskStatus, string>> = {
  queued: "Waiting for a free agent.",
  running: "An agent is working on this. Updates appear below as they happen.",
};

test("pendingSummary: every status has its text, or nothing to add", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(pendingSummary(makeTask({ status }), noContext), PENDING_TEXT[status] ?? null, status);
  }
});

test("pendingSummary: a running task names who's working on it", () => {
  const text = pendingSummary(makeTask({ status: "running" }), { ...noContext, agent: agent("Ada", true) });
  assert.equal(text, "Ada is working on this. Updates appear below as they happen.");
});

test("pendingSummary: a queued task says what it waits for, the start time first", () => {
  const scheduledAt = "2999-01-01T00:00:00.000Z";
  const waiting = [{ id: "t-2" }, { id: "t-3" }];
  const both = { agent: agent("Ada", true), waitingOn: waiting, postmortemCrew: ["Bo", "Cy"] };
  const assigned = { assignee: "a-1", postmortemOf: "t-9" };
  assert.equal(pendingSummary(makeTask({ ...assigned, scheduledAt }), both),
    `Scheduled for ${new Date(scheduledAt).toLocaleString()}. It starts when an agent is free after this time and prerequisites are met.`);
  assert.equal(pendingSummary(makeTask(assigned), both), "Waiting for t-2, t-3 to land.");
  assert.equal(pendingSummary(makeTask(assigned), { ...both, waitingOn: [] }), "Waiting for Ada, who picks it up when free.");
  assert.equal(pendingSummary(makeTask(assigned), { ...both, waitingOn: [], agent: agent("Ada", false) }),
    "Waiting for Ada, who is on-call. Activate them on the Crew page.");
  assert.equal(pendingSummary(makeTask({ postmortemOf: "t-9" }), { ...noContext, postmortemCrew: ["Bo", "Cy"] }),
    "Waiting for a crew member who runs post-mortems: Bo, Cy.");
  assert.equal(pendingSummary(makeTask({ postmortemOf: "t-9" }), noContext), "Waiting for a free agent.");
});

test("pendingSummary: a start time that has passed no longer counts as scheduled", () => {
  assert.equal(pendingSummary(makeTask({ scheduledAt: "2000-01-01T00:00:00.000Z" }), noContext), "Waiting for a free agent.");
});

test("mergingSummary names the agent, or says one is needed", () => {
  assert.equal(mergingSummary({ name: "Ada" }, "main"), "Ada is merging this into main. Progress appears in the activity below.");
  assert.equal(mergingSummary(null, "trunk"), "Waiting for a free agent to merge this into trunk. Progress appears in the activity below.");
});

test("scheduleOrigin prefers the recording event's words", () => {
  const recorded = { ...event(1, "status", "Started by the nightly review"), data: { scheduleId: "s-1" } };
  assert.equal(scheduleOrigin({ scheduleId: "s-1" }, [event(2, "status"), recorded]), "Started by the nightly review");
  assert.equal(scheduleOrigin({ scheduleId: "s-1" }, []), "Started by crew schedule s-1");
});

test("visual review: pending, waived, and recorded decisions read differently", () => {
  const branch = "crane/x";
  const pending = makeTask({ branch });
  assert.equal(visualReviewHeading(pending), "Needs your decision");
  assert.equal(visualReviewText(pending), "Approval and merging wait for candidate inspection or an explicit waiver.");
  const waived = makeTask({ branch, preApprovedAt: "2026-01-01" });
  assert.equal(visualReviewHeading(waived), "Waived by pre-approval");
  assert.equal(visualReviewText(waived), "Your pre-approval waives visual review for this task, including conflict resolutions.");
  const decided = makeTask({ branch, visualReview: { status: "not_required", note: "No UI changed" } });
  assert.equal(visualReviewHeading(decided), "not required");
  assert.equal(visualReviewText(decided), "No UI changed");
});

test("decision copy: a merge failure outranks the branch, and unmet criteria come first", () => {
  assert.equal(decisionHeading("b", "Conflict.", "main"), "Couldn't merge into main");
  assert.equal(decisionHeading("b", undefined, "main"), "Changes are ready for review");
  assert.equal(decisionHeading(null, undefined, "main"), "The report is ready");
  const input = { branch: "b", mergeError: undefined, main: "main", unmet: 0 };
  assert.equal(decisionText({ ...input, mergeError: "Conflict." }), "Conflict. Try again, approve only to merge it yourself, or decline.");
  assert.equal(decisionText(input), "Approving merges b into main and pushes it. An agent resolves any conflicts. Declining throws it away.");
  assert.equal(decisionText({ ...input, branch: null }), "Act on a finding below, or mark this as reviewed.");
  assert.match(decisionText({ ...input, unmet: 1 }), /^The report doesn't show an acceptance criterion met, so approving accepts a reduced scope\. Approving merges/);
  assert.match(decisionText({ ...input, unmet: 2 }), /^The report doesn't show 2 acceptance criteria met/);
});

test("prerequisites and pre-approval copy", () => {
  assert.match(prerequisitesText(1, "main"), /^It waits for this to land on main\. Waive it/);
  assert.match(prerequisitesText(2, "main"), /^It waits for these to land on main\. Waive them/);
  assert.match(preApprovalText(true, "main", " and more"), /^Once its checks pass and more, Crane merges it into main\./);
  assert.match(preApprovalText(false, "main", ""), /^Pre-approve it and Crane merges it into main once its checks pass\./);
});

test("usedDriver: a queued task follows the operator's choice; others, the agent that worked it", () => {
  const runs = [{ kind: "work", driver: "codex" }, { kind: "work", driver: "unknown" }, { kind: "merge", driver: "simulated" }] as Pick<AgentRun, "kind" | "driver">[];
  assert.equal(usedDriver({ status: "queued", driver: "claude" }, runs), "claude");
  assert.equal(usedDriver({ status: "queued", driver: null }, runs), "codex");
  assert.equal(usedDriver({ status: "failed", driver: "claude" }, runs), "codex");
  assert.equal(usedDriver({ status: "failed", driver: "claude" }, []), "claude");
  assert.equal(usedDriver({ status: "queued", driver: null }, []), null);
  assert.equal(driverName(null), null);
});

test("waitingOn: only a queued task with unwaived, unmet prerequisites waits", () => {
  const list = [prerequisite("t-2", true), prerequisite("t-3", false)] as never[];
  assert.deepEqual(waitingOn({ status: "queued", prerequisitesWaivedAt: null }, list).map((p: { id: string }) => p.id), ["t-3"]);
  assert.deepEqual(waitingOn({ status: "queued", prerequisitesWaivedAt: "2026-01-01" }, list), []);
  assert.deepEqual(waitingOn({ status: "running", prerequisitesWaivedAt: null }, list), []);
});

test("taskView reads a backend that sends no gates, follow-ups or source as empty", () => {
  const legacy = { task: makeTask({ acceptance: undefined, acceptanceChecks: undefined }), repo: null, agent: null, events: [], runs: [], blocked: [] };
  const view = taskView(legacy as unknown as TaskDetail, []);
  assert.deepEqual(view.prerequisites, []);
  assert.deepEqual(view.followUps, []);
  assert.equal(view.source, null);
  assert.equal(view.required, 0);
  assert.equal(view.acceptanceGate, "");
  assert.equal(view.main, "main");
  assert.equal(view.canPreApprove, false);
});

test("taskView: pre-approval needs a repo, a pending task, and freedom to change code", () => {
  const detail = (over: Record<string, unknown>) => ({ task: makeTask(over), repo: { defaultBranch: "trunk" }, runs: [] }) as unknown as TaskDetail;
  assert.equal(taskView(detail({ status: "running" }), []).canPreApprove, true);
  assert.equal(taskView(detail({ status: "running" }), []).main, "trunk");
  assert.equal(taskView(detail({ status: "needs_review" }), []).canPreApprove, false);
  assert.equal(taskView(detail({ autonomy: "observe" }), []).canPreApprove, false);
});

test("taskView counts criteria the report doesn't show met, only once there is a report", () => {
  const acceptance = ["One", "Two"];
  const detail = (report: unknown) => ({ task: makeTask({ acceptance, report }), repo: null, runs: [] }) as unknown as TaskDetail;
  assert.deepEqual(taskView(detail(null), []).unmet, []);
  const report = { acceptance: [{ criterion: "One", met: true, evidence: "" }] };
  assert.deepEqual(taskView(detail(report), []).unmet, ["Two"]);
  assert.match(taskView(detail(report), []).acceptanceGate, /every acceptance criterion met/);
});

test("isWorking needs a running task on a branch", () => {
  assert.equal(isWorking(undefined), false);
  assert.equal(isWorking(makeTask({ status: "running" })), false);
  assert.equal(isWorking(makeTask({ status: "queued", branch: "b" })), false);
  assert.equal(isWorking(makeTask({ status: "running", branch: "b" })), true);
});

test("canStartFollowUp: only after nothing started, or one that shipped nothing", () => {
  assert.equal(canStartFollowUp(undefined), true);
  for (const status of ["failed", "cancelled", "rejected"] as const) assert.equal(canStartFollowUp({ status }), true, status);
  for (const status of ["queued", "running", "merged"] as const) assert.equal(canStartFollowUp({ status }), false, status);
});

test("runOutcomeLabel names only the runs that went wrong", () => {
  assert.equal(runOutcomeLabel("failed"), "Failed");
  assert.equal(runOutcomeLabel("cancelled"), "Cancelled");
  assert.equal(runOutcomeLabel("running"), null);
});

test("showsRuns: several runs, or one that spent something", () => {
  const free = { costUsd: 0, outputTokens: 0 };
  assert.equal(showsRuns([]), false);
  assert.equal(showsRuns([free]), false);
  assert.equal(showsRuns([free, free]), true);
  assert.equal(showsRuns([{ ...free, costUsd: 0.1 }]), true);
  assert.equal(showsRuns([{ ...free, outputTokens: 5 }]), true);
});

test("groupEvents folds runs of tool calls and leaves everything else in order", () => {
  const groups = groupEvents([event(1, "tool"), event(2, "tool"), event(3, "status"), event(4, "tool")]);
  assert.deepEqual(groups.map((g) => ("tools" in g ? g.tools.map((e) => e.id) : g.id)), [[1, 2], 3, [4]]);
});

test("event streams keep each event once, in the order first seen", () => {
  const polled = [event(1, "status"), event(2, "status")];
  assert.deepEqual(uniqueEvents(polled, [event(2, "status"), event(3, "status"), event(3, "status")]).map((e) => e.id), [1, 2, 3]);
  const live = [event(3, "status")];
  assert.equal(addLiveEvent(live, event(3, "status")), live);
  assert.deepEqual(addLiveEvent(live, event(4, "status")).map((e) => e.id), [3, 4]);
});

test("changesFor never shows another task's changes", () => {
  const state = { id: "t-1", diff: { files: [] }, error: "Stale" };
  assert.deepEqual(changesFor(state, "t-1"), { diff: state.diff, error: "Stale" });
  assert.deepEqual(changesFor(state, "t-2"), { diff: null, error: null });
});
