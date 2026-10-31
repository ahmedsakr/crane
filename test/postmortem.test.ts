import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { postmortemBrief } from "../src/factory/postmortem.js";

test("a successful merge queues exactly one independent read-only post-mortem", () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ name: "example", path: "/tmp/example", defaultBranch: "main", isFactory: false });
    const task = store.createTask({ kind: "repo_feature", title: "Feature", brief: "Build it", repoId: repo.id, autonomy: "propose", driver: "codex" });
    store.updateTask(task.id, { sessionId: "original-session", worktree: "/tmp/worktree", report: { summary: "Shipped", findings: [], changedFiles: ["app.ts"] } });
    store.addEvent(task.id, "blocked", "Command refused", { command: "npm ci", rules: [] });
    assert.throws(() => store.completeMerge(task.id, "Merged", {}), /isn't merging/);
    assert.equal(store.listTasks().length, 1);
    store.setStatus(task.id, "merging");
    const review = store.completeMerge(task.id, "Merged into main", { merge: { commit: "abc" } })!;
    assert.equal(store.getTask(task.id)!.status, "merged");
    assert.equal(store.getTask(task.id)!.worktree, null);
    assert.equal(review.status, "queued");
    assert.equal(review.autonomy, "observe");
    assert.equal(review.repoId, repo.id);
    assert.equal(review.driver, "codex");
    assert.equal(review.sessionId, null);
    assert.match(review.brief, /npm ci/);
    assert.match(review.brief, /Shipped/);
    assert.match(review.brief, /Merged into main/);
    assert.match(review.brief, /untrusted evidence/);
    assert.equal(store.listEvents(task.id).at(-1)!.data!.postmortemTaskId, review.id);
    assert.equal(store.listEvents(review.id).at(-1)!.data!.sourceTaskId, task.id);
    assert.equal(store.completeMerge(task.id, "Merged again", {}), null);
    assert.equal(store.listTasks().length, 2);
    assert.equal(store.getTask(task.id)!.report!.summary, "Shipped");
  } finally {
    store.close();
  }
});

test("history is bounded and blocked evidence survives noisy tool activity", () => {
  const task = { id: "t-source", title: "Feature", brief: "Brief", report: null } as Parameters<typeof postmortemBrief>[0];
  const events = Array.from({ length: 1000 }, (_, id) => ({ id, taskId: task.id, ts: "now", type: "tool" as const, message: "x".repeat(1000), data: null }));
  const brief = postmortemBrief(task, [{ ...events[0]!, type: "blocked", message: "npm test refused" }, ...events]);
  assert.ok(brief.length < 140000);
  assert.match(brief, /npm test refused/);
  assert.match(brief, /omitted/);
});
