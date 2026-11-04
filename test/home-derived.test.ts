import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskSummary } from "@crane/contracts";
import { agentsOnShift, goalReviewLabel, hasTargetRepo, isSiteEmpty, needsYouCount, repoNamer } from "../web/src/lib/overview.ts";
import { filterStatus, showsQueue, visibleTasks } from "../web/src/lib/task-filters.ts";

const task = (id: string, status: TaskSummary["status"]) => ({ id, status }) as TaskSummary;
const none = { needsReview: [], inFlight: [], recent: [], goalsNeedingReview: [] };

test("repoNamer: finds a repo, and tolerates no repos yet or no repo id", () => {
  const name = repoNamer([{ id: "r1", name: "crane" }]);
  assert.equal(name("r1"), "crane");
  assert.equal(name(null), undefined);
  assert.equal(repoNamer(undefined)("r1"), undefined);
});

test("isSiteEmpty: any work, including a goal awaiting review, counts", () => {
  assert.ok(isSiteEmpty(none));
  assert.ok(isSiteEmpty({ ...none, goalsNeedingReview: undefined }), "older factories omit goals");
  assert.ok(!isSiteEmpty({ ...none, recent: [task("t", "merged")] }));
  assert.ok(!isSiteEmpty({ ...none, goalsNeedingReview: [{}] as never }));
});

test("needsYouCount: adds tasks and goals", () => {
  assert.equal(needsYouCount({ needsReview: [task("t", "needs_review")], goalsNeedingReview: [{}, {}] as never }), 3);
  assert.equal(needsYouCount({ needsReview: [], goalsNeedingReview: undefined }), 0);
});

test("goalReviewLabel: a blocked goal needs attention, any other has a plan to review", () => {
  assert.equal(goalReviewLabel({ status: "blocked" }), "Needs attention");
  assert.equal(goalReviewLabel({ status: "planned" } as never), "Plan ready for review");
});

test("hasTargetRepo: the factory's own repo doesn't count", () => {
  assert.ok(!hasTargetRepo({ repos: [{ isFactory: true }] as never }));
  assert.ok(hasTargetRepo({ repos: [{ isFactory: true }, { isFactory: false }] as never }));
});

test("agentsOnShift: active agents, plus any still working after going inactive", () => {
  const agents = [
    { name: "on", active: true, state: "idle" },
    { name: "leaving", active: false, state: "working" },
    { name: "off", active: false, state: "idle" },
  ] as const;
  assert.deepEqual(agentsOnShift([...agents] as never[]).map((agent: { name: string }) => agent.name), ["on", "leaving"]);
});

test("task filters: queued work moves to the queue on filters that show it", () => {
  const data = [task("a", "running"), task("b", "queued")];
  assert.deepEqual(visibleTasks("open", data)?.map((t) => t.id), ["a"]);
  assert.deepEqual(visibleTasks("all", data)?.map((t) => t.id), ["a"]);
  assert.deepEqual(visibleTasks("review", data)?.map((t) => t.id), ["a", "b"]);
  assert.deepEqual(visibleTasks("queue", data), [], "the queue filter shows only the queue");
  assert.deepEqual(visibleTasks("queue", null), [], "and doesn't wait for a response");
  assert.equal(visibleTasks("open", null), undefined, "still loading");
});

test("task filters: each key has its statuses and queue visibility", () => {
  assert.equal(filterStatus("all"), "");
  assert.equal(filterStatus("queue"), "queued");
  assert.deepEqual((["open", "queue", "review", "finished", "problems", "all"] as const).filter(showsQueue), ["open", "queue", "all"]);
});
