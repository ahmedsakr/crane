import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { postmortemBrief } from "../src/core/postmortem.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorActions } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import type { AgentDriver, RunContext } from "../src/agents/driver.js";

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
    assert.equal(review.driverSettings, null);
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

test("post-mortem defaults survive reopening, are captured at queue time, and stay separate from normal tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-postmortem-"));
  const file = join(dir, "crane.db");
  let store = new Store(file);
  try {
    new OperatorActions(store).configurePostmortem({ driver: "claude-code", model: "sonnet", effort: "low" });
    store.close();
    store = new Store(file);
    let actions = new OperatorActions(store);
    assert.deepEqual(actions.postmortemSettings(), { driver: "claude-code", model: "sonnet", effort: "low" });
    const repo = store.addRepo({ path: "/example" });
    const task = actions.createTask({ kind: "repo_feature", title: "Feature", brief: "", repoId: repo.id, autonomy: "propose", driver: "codex" });
    assert.equal(task.driverSettings, null);
    store.setStatus(task.id, "merging");
    const review = store.completeMerge(task.id, "Merged", {})!;
    assert.equal(review.driver, "claude-code");
    assert.deepEqual(review.driverSettings, { model: "sonnet", effort: "low" });
    assert.equal(review.autonomy, "observe");
    assert.equal(review.sessionId, null);
    store.close();
    store = new Store(file);
    actions = new OperatorActions(store);
    assert.deepEqual(store.getTask(review.id)!.driverSettings, review.driverSettings, "queued overrides survive a restart");
    actions.configurePostmortem({ driver: "codex", effort: "minimal" });
    assert.deepEqual(actions.postmortemSettings(), { driver: "codex", model: null, effort: "minimal" });
    assert.deepEqual(store.getTask(review.id)!.driverSettings, review.driverSettings);
    assert.equal(store.getTask(review.id)!.driver, "claude-code");
    assert.deepEqual(actions.retry(review.id).driverSettings, review.driverSettings);
    assert.equal(actions.retry(review.id, { driver: "codex" }).driverSettings, null);
    assert.equal(actions.retry(review.id, { driver: "default" }).driverSettings, null);
    actions.configurePostmortem({ driver: "default" });
    const next = actions.createTask({ kind: "repo_feature", title: "Next", brief: "", repoId: repo.id, autonomy: "propose", driver: "codex" });
    store.setStatus(next.id, "merging");
    const inherited = store.completeMerge(next.id, "Merged", {})!;
    assert.equal(inherited.driver, "codex");
    assert.equal(inherited.driverSettings, null);
    assert.equal(store.completeMerge(next.id, "Merged again", {}), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("opening an older database adds nullable task overrides without changing existing tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-postmortem-migrate-"));
  const file = join(dir, "crane.db");
  let store = new Store(file);
  try {
    const task = store.createTask({ kind: "maintenance", title: "Existing", brief: "", repoId: null, autonomy: "observe", driver: "codex" });
    store.db.exec("ALTER TABLE tasks DROP COLUMN driver_settings");
    store.close();
    store = new Store(file);
    assert.deepEqual(store.getTask(task.id), task);
    assert.deepEqual(store.postmortemSettings(), { driver: null, model: null, effort: null });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("post-mortems run with their saved overrides while ordinary tasks use the agent's settings", async (t) => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd() });
  const seen: RunContext[] = [];
  const drivers: AgentDriver[] = ["codex", "claude-code"].map((name) => ({
    name, label: name, available: async () => true,
    run: async (ctx) => { seen.push(ctx); return { report: { summary: "Reviewed", findings: [], changedFiles: [] } }; },
  }));
  actions.configurePostmortem({ driver: "claude-code", effort: "low" });
  store.setSetting("driver_model:claude-code", "opus");
  store.setSetting("driver_effort:claude-code", "max");
  const base = { kind: "maintenance" as const, title: "Feature", brief: "", repoId: repo.id, autonomy: "observe" as const, driver: "codex" };
  const source = store.createTask(base);
  store.setStatus(source.id, "merging");
  const review = store.completeMerge(source.id, "Merged", {})!;
  const ordinary = actions.createTask({ ...base, driver: "claude-code" });
  actions.configurePostmortem({ driver: "codex", effort: "minimal" });
  const factory = new Factory(store, drivers, { crewSize: 1, tickMs: 10, buildDashboard: false });
  t.after(async () => { await factory.stop(); store.close(); });
  factory.start();
  for (let i = 0; i < 500 && store.getTask(ordinary.id)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getTask(review.id)!.status, "done");
  assert.equal(store.getTask(ordinary.id)!.status, "done");
  assert.equal(store.listRuns(review.id)[0]!.driver, "claude-code");
  const ctx = seen.find((c) => c.task.id === review.id)!;
  assert.equal(ctx.model, "opus", "an unset override follows the agent's saved model");
  assert.equal(ctx.effort, "low", "a queued override survives later preference changes");
  assert.equal(ctx.task.autonomy, "observe");
  assert.equal(ctx.resumeSession, undefined);
  assert.equal(seen.find((c) => c.task.id === ordinary.id)!.effort, "max");
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
