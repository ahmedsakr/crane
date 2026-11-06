import { test } from "node:test";
import assert from "node:assert/strict";
import type { BlockedTool, TaskStatus } from "@crane/contracts";
import { nextSteps, type NextStepFacts, type NextStepTask } from "../src/cli/commands/next-steps.js";

/** `crane show`'s next-step hints, one test per task status. Only the commands are compared where the wording is incidental. */

const task = (status: TaskStatus, extra: Partial<NextStepTask> = {}): NextStepTask => ({
  id: "t-1", status, branch: "crane/x-t-1", autonomy: "propose", preApprovedAt: null, report: null, ...extra,
});
const facts = (extra: Partial<NextStepFacts> = {}): NextStepFacts => ({ main: "main", waiting: [], ...extra });
const commands = (t: NextStepTask, f = facts()) => nextSteps(t, f).map(([command]) => command);

test("next steps: needs_review offers approve, approve-only, decline and diff for a branch", () => {
  assert.deepEqual(nextSteps(task("needs_review"), facts()), [
    ["crane approve t-1", "merge into main and push"],
    ["crane approve t-1 --no-merge", "approve only, keep crane/x-t-1"],
    ["crane decline t-1", "discard the branch"],
    ["crane diff t-1", "see the changes"],
  ]);
});

test("next steps: needs_review without a branch marks as reviewed, and an observe report offers a follow-up", () => {
  const report = { summary: "", findings: [{ title: "f", detail: "", impact: "low", effort: "small" }], changedFiles: [] } as NextStepTask["report"];
  assert.deepEqual(nextSteps(task("needs_review", { branch: null, autonomy: "observe", report }), facts()), [
    ["crane approve t-1", "mark as reviewed"],
    ["crane decline t-1", "dismiss"],
    ["crane follow-up t-1 1", "act on finding 1"],
  ]);
});

test("next steps: queued offers waive when prerequisites are waiting, then watch, cancel and pre-approve", () => {
  assert.deepEqual(nextSteps(task("queued"), facts({ waiting: ["t-2", "t-3"] })), [
    ['crane waive t-1 -m "…"', "start it without t-2, t-3, accepting a reduced scope"],
    ["crane watch t-1", "follow along live"],
    ["crane cancel t-1", "stop it"],
    ["crane pre-approve t-1", "merge into main once its checks pass"],
  ]);
  assert.deepEqual(commands(task("queued", { autonomy: "observe" })), ["crane watch t-1", "crane cancel t-1"]);
});

test("next steps: running shows the diff so far, and pre-approved work offers undo", () => {
  assert.deepEqual(nextSteps(task("running", { preApprovedAt: "2030-01-01T00:00:00Z" }), facts({ waiting: ["t-2"] })), [
    ["crane watch t-1", "follow along live"],
    ["crane diff t-1", "see the changes so far"],
    ["crane cancel t-1", "stop it"],
    ["crane pre-approve t-1 --undo", "wait for your review instead of merging"],
  ]);
});

test("next steps: merging follows the merge", () => {
  assert.deepEqual(nextSteps(task("merging"), facts()), [["crane watch t-1", "follow the merge"]]);
});

test("next steps: failed and cancelled offer a retry", () => {
  for (const status of ["failed", "cancelled"] as const) {
    assert.deepEqual(nextSteps(task(status), facts()), [["crane retry t-1", "run it again"]]);
  }
});

test("next steps: approved and done merge a branch, and have nothing without one", () => {
  for (const status of ["approved", "done"] as const) {
    assert.deepEqual(nextSteps(task(status), facts({ main: "trunk" })), [["crane merge t-1", "merge into trunk and push"]]);
    assert.deepEqual(nextSteps(task(status, { branch: null }), facts()), []);
  }
});

test("next steps: merged catches a behind checkout up, and is otherwise done", () => {
  assert.deepEqual(nextSteps(task("merged"), facts({ checkoutBehind: "/home/me/app" })), [
    ["git -C /home/me/app pull --ff-only", "catch your checkout up, once it's clean"],
  ]);
  assert.deepEqual(nextSteps(task("merged"), facts()), []);
});

test("next steps: rejected has nothing to do", () => {
  assert.deepEqual(nextSteps(task("rejected"), facts()), []);
});

test("next steps: a blocked command adds an allow hint after the status's own", () => {
  const blocked = { rule: "Bash(npm ci)", label: "npm ci", repoName: "app" } as BlockedTool;
  assert.deepEqual(nextSteps(task("rejected"), facts({ blocked })), [['crane allow "npm ci" -r app -t t-1', "let agents run it in app"]]);
  assert.deepEqual(commands(task("failed"), facts({ blocked })), ["crane retry t-1", 'crane allow "npm ci" -r app -t t-1']);
});
