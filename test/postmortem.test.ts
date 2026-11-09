import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "@crane/storage";
import { postmortemBrief, postmortemPrompt } from "../packages/storage/src/postmortem.js";
import { resumePrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorActions } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import type { AgentDriver, RunContext } from "@crane/agent-protocol";

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
    assert.equal(review.brief, `Evaluate the execution of successfully merged task ${task.id}: Feature.`, "the history stays with the merged task");
    const prompt = store.postmortemPrompt(review.postmortemOf!);
    assert.match(prompt, /npm ci/);
    assert.match(prompt, /Shipped/);
    assert.match(prompt, /Merged into main/);
    assert.match(prompt, /untrusted evidence/);
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
    assert.deepEqual(actions.postmortemSettings(), { driver: "claude-code", model: "sonnet", effort: "low", crew: [] });
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
    assert.deepEqual(actions.postmortemSettings(), { driver: "codex", model: null, effort: "minimal", crew: [] });
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
    assert.deepEqual(store.postmortemSettings(), { driver: null, model: null, effort: null, crew: [] });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** A store with a crew, an unrelated queued task, and one post-mortem waiting. */
function crewWithPostmortem() {
  const store = new Store(":memory:");
  for (const name of ["Jib", "Boom", "Hoist"]) store.upsertAgent({ id: `a-${name.toLowerCase()}`, name, driver: "simulated" });
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/example" });
  const base = { kind: "maintenance" as const, title: "Feature", brief: "", repoId: repo.id, autonomy: "observe" as const };
  const source = store.createTask(base);
  store.setStatus(source.id, "merging");
  const review = store.completeMerge(source.id, "Merged", {})!;
  return { store, actions, repo, base, source, review };
}

test("with no crew named, post-mortems stay with any active general member", () => {
  const { store, source, review } = crewWithPostmortem();
  try {
    assert.equal(review.postmortemOf, source.id);
    assert.equal(store.queuedForAnyone(), 1);
    assert.equal(store.claimNextTask("a-hoist", { onlyPostmortems: true }), null, "on-call members aren't called in");
    assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true }), null, "role members keep to their own runs");
    assert.equal(store.claimNextTask("a-jib")?.id, review.id);
  } finally { store.close(); }
});

test("a named on-call member is called in for post-mortems and nothing else", () => {
  const { store, actions, base, review } = crewWithPostmortem();
  try {
    actions.configurePostmortem({ crew: ["a-hoist"] });
    const ordinary = store.createTask(base);
    const forHoist = store.createTask({ ...base, assignee: "a-hoist" });
    assert.equal(store.claimNextTask("a-jib")?.id, ordinary.id, "an unnamed member skips the older post-mortem");
    assert.equal(store.claimNextTask("a-jib"), null);
    assert.equal(store.claimNextTask("a-boom", { onlyPostmortems: true }), null, "an unnamed member isn't called in");
    assert.equal(store.claimNextTask("a-hoist", { onlyPostmortems: true })?.id, review.id);
    assert.equal(store.claimNextTask("a-hoist", { onlyPostmortems: true }), null, "work assigned to them waits until they're active");
    assert.equal(store.getTask(forHoist.id)!.status, "queued");
  } finally { store.close(); }
});

test("a named active member takes post-mortems alongside their usual work, even with a role", () => {
  const { store, actions, base, review } = crewWithPostmortem();
  try {
    actions.configurePostmortem({ crew: ["a-boom"] });
    const run = store.createTask({ ...base, assignee: "a-boom" });
    const ordinary = store.createTask(base);
    assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true })?.id, review.id);
    assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true })?.id, run.id);
    assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true }), null, "a role still leaves general work alone");
    assert.equal(store.getTask(ordinary.id)!.status, "queued");
  } finally { store.close(); }
});

test("post-mortem crew: a change reaches waiting reviews, and a retry stays a post-mortem", () => {
  const { store, actions, source, review } = crewWithPostmortem();
  try {
    assert.deepEqual(actions.configurePostmortem({ crew: ["a-hoist", "a-hoist"] }).crew, ["a-hoist"]);
    assert.equal(store.claimNextTask("a-jib"), null);
    actions.configurePostmortem({ crew: [] });
    actions.cancel(review.id);
    const retried = actions.retry(review.id);
    assert.equal(retried.postmortemOf, source.id);
    actions.configurePostmortem({ crew: ["a-boom"] });
    assert.equal(store.claimNextTask("a-jib"), null, "the retry still goes to the named crew");
    assert.equal(store.claimNextTask("a-boom", { onlyPostmortems: true })?.id, retried.id);
  } finally { store.close(); }
});

test("post-mortem crew: unknown members are refused, and departed ones can't strand a review", () => {
  const { store, actions, review } = crewWithPostmortem();
  try {
    actions.configurePostmortem({ crew: ["a-hoist"] });
    for (const crew of ["a-hoist", [42], ["a-ghost"], ["a-jib", "a-ghost"], null] as unknown as string[][]) {
      assert.throws(() => actions.configurePostmortem({ crew }));
      assert.deepEqual(actions.postmortemSettings().crew, ["a-hoist"], "a refused change saves nothing");
    }
    assert.deepEqual(actions.configurePostmortem({ driver: "codex" }).crew, ["a-hoist"], "other changes keep the crew");
    store.pruneAgents(["a-jib", "a-boom"]);
    assert.deepEqual(actions.postmortemSettings().crew, []);
    assert.equal(store.claimNextTask("a-jib")?.id, review.id);
  } finally { store.close(); }
});

test("post-mortem crew: agents report it, and activating someone else wouldn't help a named review", () => {
  const { store, actions } = crewWithPostmortem();
  try {
    actions.configurePostmortem({ crew: ["a-hoist"] });
    assert.deepEqual(store.listAgents().filter((a) => a.runsPostmortems).map((a) => a.id), ["a-hoist"]);
    assert.equal(store.queuedForAnyone(), 0);
    actions.configurePostmortem({ crew: [] });
    assert.deepEqual(store.listAgents().filter((a) => a.runsPostmortems), []);
    assert.equal(store.queuedForAnyone(), 1);
  } finally { store.close(); }
});

test("opening an older database links post-mortems from their queue note", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-postmortem-links-"));
  const file = join(dir, "crane.db");
  let store = new Store(file);
  try {
    const repo = store.addRepo({ path: "/example" });
    const base = { kind: "maintenance" as const, title: "Feature", brief: "", repoId: repo.id, autonomy: "observe" as const };
    const source = store.createTask(base);
    store.setStatus(source.id, "merging");
    const review = store.completeMerge(source.id, "Merged", {})!;
    const ordinary = store.createTask(base);
    store.addEvent(ordinary.id, "note", "Not json", null);
    store.db.exec("ALTER TABLE tasks DROP COLUMN postmortem_of");
    store.close();
    store = new Store(file);
    assert.equal(store.getTask(review.id)!.postmortemOf, source.id);
    assert.equal(store.getTask(source.id)!.postmortemOf, null);
    assert.equal(store.getTask(ordinary.id)!.postmortemOf, null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("factory: a named on-call member runs post-mortems without taking other work or merges", async (t) => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd() });
  const driver: AgentDriver = {
    name: "simulated", label: "simulated", available: async () => true,
    run: async () => ({ report: { summary: "Reviewed", findings: [], changedFiles: [] } }),
  };
  store.upsertAgent({ id: "a-hoist", name: "Hoist", driver: "simulated" });
  actions.configurePostmortem({ crew: ["a-hoist"] });
  // Everyone is on-call, so only the call-in can start anything.
  store.setSetting("crew_active_a-jib", "false");
  const factory = new Factory(store, [driver], { crewSize: 1, tickMs: 10, buildDashboard: false });
  t.after(async () => { await factory.stop(); store.close(); });
  const base = { kind: "maintenance" as const, title: "Feature", brief: "", repoId: repo.id, autonomy: "observe" as const };
  const source = store.createTask(base);
  store.setStatus(source.id, "merging");
  const review = store.completeMerge(source.id, "Merged", {})!;
  const ordinary = store.createTask(base);
  const approved = store.createTask(base);
  store.setStatus(approved.id, "merging");
  factory.start();
  for (let i = 0; i < 500 && store.getTask(review.id)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getTask(review.id)!.status, "done");
  assert.equal(store.getTask(review.id)!.agentId, "a-hoist");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.crewActive("a-hoist"), false, "they stay on-call afterwards");
  assert.equal(store.getTask(ordinary.id)!.status, "queued", "on-call for everything else");
  assert.equal(store.getTask(approved.id)!.agentId, null, "merges wait for an active member");
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

test("a post-mortem's agent gets the merged task's history once, on every fresh run and after a retry", async (t) => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd() });
  const seen: RunContext[] = [];
  const driver: AgentDriver = {
    name: "simulated", label: "simulated", available: async () => true,
    run: async (ctx) => { seen.push(ctx); return { report: { summary: "Reviewed", findings: [], changedFiles: [] } }; },
  };
  const base = { kind: "maintenance" as const, title: "Feature", brief: "Build the feature", repoId: repo.id, autonomy: "observe" as const };
  const source = store.createTask(base);
  store.addEvent(source.id, "blocked", "Command refused", { command: "npm ci" });
  store.setStatus(source.id, "merging");
  const review = store.completeMerge(source.id, "Merged", {})!;
  const ordinary = store.createTask(base);
  const factory = new Factory(store, [driver], { crewSize: 1, tickMs: 10, buildDashboard: false });
  t.after(async () => { await factory.stop(); store.close(); });
  factory.start();
  for (let i = 0; i < 500 && store.getTask(ordinary.id)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getTask(review.id)!.status, "done");
  const ctx = seen.find((c) => c.task.id === review.id)!;
  assert.equal(ctx.task.brief.includes("\n"), false);
  const prompt = userPrompt(ctx.task, undefined, ctx);
  assert.match(prompt, /npm ci/);
  assert.match(prompt, /Build the feature/);
  assert.equal(prompt.split("Evaluate the execution of successfully merged task").length, 2, "the first line isn't repeated");
  assert.doesNotMatch(resumePrompt(ctx), /npm ci/, "a resumed session already has it");
  assert.equal(seen.find((c) => c.task.id === ordinary.id)!.postmortemPrompt, undefined);

  const retried = actions.retry(review.id);
  assert.equal(retried.brief, review.brief, "a retry stays one line");
  for (let i = 0; i < 500 && store.getTask(retried.id)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(seen.find((c) => c.task.id === retried.id)!.postmortemPrompt!, /npm ci/);
});

test("a post-mortem says so when its history is missing, instead of leaving gaps to guess at", () => {
  const store = new Store(":memory:");
  try {
    assert.match(store.postmortemPrompt("t-gone"), /t-gone is no longer in Crane.*evidence gap/);
    const source = store.createTask({ kind: "maintenance", title: "Feature", brief: "", repoId: null, autonomy: "observe" });
    store.db.prepare("DELETE FROM events WHERE task_id = ?").run(source.id);
    const prompt = store.postmortemPrompt(source.id);
    assert.match(prompt, /Blocked calls and errors:\nNone recorded\./);
    assert.match(prompt, /Activity history:\nNone recorded\./);
  } finally { store.close(); }
});

test("opening a database shrinks stored histories, leaving work in flight and other tasks alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-postmortem-briefs-"));
  const file = join(dir, "crane.db");
  let store = new Store(file);
  try {
    const base = { kind: "maintenance" as const, title: "Feature", repoId: null, autonomy: "observe" as const };
    const source = store.createTask({ ...base, brief: "Build it" });
    const firstLine = postmortemBrief(source);
    const stored = postmortemPrompt(source, []);
    const finished = store.createTask({ ...base, brief: stored, postmortemOf: source.id });
    store.setStatus(finished.id, "done");
    const queued = store.createTask({ ...base, brief: stored, postmortemOf: source.id });
    const ordinary = store.createTask({ ...base, brief: `${firstLine}\n\nWritten by the operator` });
    store.setStatus(ordinary.id, "done");
    const asWritten = store.createTask({ ...base, brief: "Check this\nby hand", postmortemOf: source.id });
    store.setStatus(asWritten.id, "done");
    store.close();

    store = new Store(file);
    assert.equal(store.getTask(finished.id)!.brief, firstLine);
    assert.equal(store.getTask(queued.id)!.brief, stored, "an older factory may still be about to run it");
    assert.equal(store.getTask(ordinary.id)!.brief, `${firstLine}\n\nWritten by the operator`);
    assert.equal(store.getTask(asWritten.id)!.brief, "Check this\nby hand");

    store.setStatus(queued.id, "cancelled");
    store.close();
    store = new Store(file);
    assert.equal(store.getTask(queued.id)!.brief, firstLine, "it's shrunk once it's finished");
    const prompt = userPrompt(store.getTask(queued.id)!, undefined, { postmortemPrompt: store.postmortemPrompt(source.id) });
    assert.match(prompt, /Build it/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a queued post-mortem with a stored history runs from the current render, not both", () => {
  const source = { id: "t-source", title: "Feature", brief: "Brief", report: null } as Parameters<typeof postmortemPrompt>[0];
  const stored = postmortemPrompt(source, []);
  const task = { title: "Post-mortem: Feature", brief: stored, prerequisites: [], acceptance: [], acceptanceChecks: [], lookouts: [], autonomy: "observe" } as unknown as Parameters<typeof userPrompt>[0];
  const prompt = userPrompt(task, undefined, { postmortemPrompt: postmortemPrompt(source, []) });
  assert.equal(prompt.split("Act as Crane's post-mortem agent").length, 2);
});

test("history is bounded and blocked evidence survives noisy tool activity", () => {
  const task = { id: "t-source", title: "Feature", brief: "Brief", report: null } as Parameters<typeof postmortemPrompt>[0];
  const events = Array.from({ length: 1000 }, (_, id) => ({ id, taskId: task.id, ts: "now", type: "tool" as const, message: "x".repeat(1000), data: null }));
  const brief = postmortemPrompt(task, [{ ...events[0]!, type: "blocked", message: "npm test refused" }, ...events]);
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
  } as unknown as Parameters<typeof postmortemPrompt>[0];
  const event = (id: number, message: string, data: Record<string, unknown> | null = null) =>
    ({ id, taskId: task.id, ts: "now", type: "tool" as const, message, data });
  const events = [
    event(1, "earliest agent step"),
    ...Array.from({ length: 20 }, (_, i) => event(i + 2, "x".repeat(1000))),
    { ...event(30, "Review check passed: npm test", { validation: review }), type: "note" as const },
    { ...event(31, "Merge check passed: npm test", { validation: merge }), type: "note" as const },
  ];
  const brief = postmortemPrompt(task, events);
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
