import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { postmortemBrief } from "../src/core/postmortem.js";

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

test("passing check logs are cut so they can't push out the agent's activity or later checks", () => {
  const passingLog = (phase: string) =>
    `${Array.from({ length: 700 }, (_, i) => `ok ${i + 1} - ${phase}: a test name long enough to fill`).join("\n")}\n# tests 700\n# pass 700\n# fail 0\n# duration_ms 1234\n`;
  const run = (phase: "review" | "merge", status: "passed" | "failed", logs: string) =>
    ({ phase, commit: `${phase}-commit`, command: "npm test", status, exitCode: status === "passed" ? 0 : 1, logs, durationMs: 4200 });
  const review = run("review", "passed", passingLog("review"));
  const merge = run("merge", "passed", passingLog("merge"));
  assert.ok(review.logs.length > 30000 && merge.logs.length > 30000);
  const failed = run("merge", "failed", `${"setup noise\n".repeat(1000)}not ok 7 - the real failure\n# fail 1\n`);
  const task = {
    id: "t-source", title: "Feature", brief: "Brief",
    report: { summary: "Shipped", findings: [], changedFiles: [], validation: [review, failed, merge] },
  } as unknown as Parameters<typeof postmortemBrief>[0];
  const event = (id: number, message: string, data: Record<string, unknown> | null = null) =>
    ({ id, taskId: task.id, ts: "now", type: "tool" as const, message, data });
  const events = [
    event(1, "earliest agent step"),
    ...Array.from({ length: 20 }, (_, i) => event(i + 2, "x".repeat(1000))),
    { ...event(30, "Review check passed: npm test", { validation: review }), type: "note" as const },
    { ...event(31, "Merge check passed: npm test", { validation: merge }), type: "note" as const },
  ];
  const brief = postmortemBrief(task, events);
  assert.match(brief, /earliest agent step/);
  assert.doesNotMatch(brief, /Earlier or oversized events omitted/);
  assert.doesNotMatch(brief, /a test name long enough/);
  assert.match(brief, /# tests 700\\n# pass 700\\n# fail 0/);
  const finalReport = brief.split("Final report:\n")[1]!.split("\n\nBlocked calls")[0]!;
  assert.match(finalReport, /"phase":"merge","commit":"merge-commit","command":"npm test","status":"passed","exitCode":0/);
  assert.match(finalReport, /"durationMs":4200\}\]/);
  assert.match(finalReport, /not ok 7 - the real failure/);
  assert.match(finalReport, /earlier characters omitted/);
  assert.equal(task.report!.validation![0]!.logs, review.logs);
});
