import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_STATUSES, FINISHED_STATUSES, type TaskStatus } from "@crane/contracts";
import { Store } from "@crane/storage";
import { StorageMaintenance } from "@crane/storage";
import { retainScreenshots, screenshotPath } from "@crane/storage";
// Keep private tests on the compiled Store identity used by actions and routes.
import { pruneOrphanScreenshots } from "../packages/storage/dist/screenshots.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";

const clock = Date.parse("2026-10-20T12:00:00.000Z");
const day = 86_400_000;
const old = new Date(clock - 40 * day).toISOString();
const cutoff = new Date(clock - 30 * day).toISOString();

function setup(t: TestContext, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "crane-retention-"));
  const previousHome = process.env.CRANE_HOME;
  process.env.CRANE_HOME = root;
  const file = join(root, "crane.db");
  if (legacy) {
    const db = new Database(file);
    db.exec("CREATE TABLE legacy_fixture (value TEXT)");
    db.close();
  }
  const store = new Store(file);
  t.after(() => {
    store.close();
    if (previousHome === undefined) delete process.env.CRANE_HOME;
    else process.env.CRANE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  const task = (status: TaskStatus = "done", finishedAt: string | null = old) => {
    const task = store.createTask({ kind: "maintenance", title: "History", brief: "", repoId: null, autonomy: "observe" });
    store.updateTask(task.id, { status, finishedAt });
    return task.id;
  };
  const ageEvents = () => store.db.prepare("UPDATE events SET ts = ?").run(old);
  return { root, store, task, ageEvents };
}

test("retention: disabled by default, with no deletion or legacy vacuum on store open or tick", t => {
  const { store, task, ageEvents } = setup(t, true);
  const id = task();
  store.addEvent(id, "tool", "Large tool result");
  ageEvents();
  assert.deepEqual(store.retentionSettings(), { finishedTaskDays: null });
  const events = store.listEvents(id);
  const logs: string[] = [];
  new StorageMaintenance(store, m => logs.push(m)).tick(clock);
  assert.deepEqual(store.listEvents(id), events);
  assert.deepEqual(logs, []);
  assert.equal(store.db.pragma("auto_vacuum", { simple: true }), 0);
});

test("retention: prunes only old tool events and explicitly routine notes, retaining audit and ledger", t => {
  const { store, task, ageEvents } = setup(t);
  const id = task();
  store.addEvent(id, "tool", "Tool output");
  store.addEvent(id, "note", "Narration", { routine: true });
  for (const type of ["status", "operator", "blocked", "error", "finding"] as const) {
    store.addEvent(id, type, `Preserve ${type}`, { routine: true });
  }
  store.addEvent(id, "note", "Legacy unclassified note");
  store.addEvent(id, "note", "Merge outcome", { merge: { commit: "abc" } });
  store.addEvent(id, "note", "Failed check", { validation: { status: "failed" } });
  store.addEvent(id, "note", "Session restart", { retry: true });
  ageEvents();
  const recent = store.addEvent(id, "tool", "Recent evidence");
  store.db.prepare("UPDATE events SET ts = ? WHERE id = ?").run(new Date(clock).toISOString(), recent.id);
  const run = store.startRun({ taskId: id, kind: "work", agentId: null, driver: "test" });
  store.finishRun(run, "succeeded", { costUsd: 3, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, model: "test" });
  const beforeTask = store.getTask(id);
  const beforeRuns = store.listRuns(id);
  const analyticsNow = Date.now();
  const beforeAnalytics = store.analytics(7, analyticsNow);
  assert.equal(store.pruneTaskHistory(cutoff, 30), 2);
  assert.deepEqual(store.getTask(id), beforeTask);
  assert.deepEqual(store.listRuns(id), beforeRuns);
  assert.deepEqual(store.analytics(7, analyticsNow), beforeAnalytics);
  const events = store.listEvents(id);
  assert.ok(events.some(e => e.id === recent.id));
  assert.equal(events.filter(e => e.message.startsWith("Preserve")).length, 5);
  for (const message of ["Legacy unclassified note", "Merge outcome", "Failed check", "Session restart"]) {
    assert.ok(events.some(e => e.message === message), message);
  }
  assert.ok(events.some(e => e.data?.retention && /Trimmed 2/.test(e.message)));
  assert.equal(store.pruneTaskHistory(cutoff, 30), 0, "repeated sweep is idempotent");
});

test("retention: respects finished age, lifecycle state, recent events and unfinished runs", t => {
  const { store, task, ageEvents } = setup(t);
  const ids = ALL_STATUSES.map(status => ({ status, id: task(status) }));
  const fresh = task("done", new Date(clock - day).toISOString());
  const boundary = task("done", cutoff);
  const undated = task("done", null);
  const running = task("cancelled");
  store.startRun({ taskId: running, kind: "work", agentId: null, driver: "test" });
  for (const id of [...ids.map(t => t.id), fresh, boundary, undated, running]) store.addEvent(id, "tool", "Output");
  ageEvents();
  assert.equal(store.pruneTaskHistory(cutoff, 30), FINISHED_STATUSES.length);
  for (const { id, status } of ids) {
    assert.equal(store.listEvents(id).some(e => e.type === "tool"), !FINISHED_STATUSES.includes(status), status);
  }
  for (const id of [fresh, boundary, undated, running]) assert.ok(store.listEvents(id).some(e => e.type === "tool"));
});

test("retention: a merged task keeps its history until its waiting post-mortem has finished", t => {
  const { store, task, ageEvents } = setup(t);
  const source = task("merged");
  store.addEvent(source, "tool", "Source activity");
  store.addEvent(source, "note", "Source narration", { routine: true });
  const unrelated = task("merged");
  store.addEvent(unrelated, "tool", "Unrelated activity");
  ageEvents();
  const review = store.createTask({ kind: "maintenance", title: "Post-mortem", brief: "", repoId: null, autonomy: "observe", postmortemOf: source });
  const pruneWhile = (status: TaskStatus) => {
    store.updateTask(review.id, { status, finishedAt: old });
    return store.pruneTaskHistory(cutoff, 30);
  };

  assert.equal(pruneWhile("queued"), 1, "only the unrelated task is trimmed");
  assert.equal(store.listEvents(unrelated).some(e => e.type === "tool"), false);
  const prompt = store.postmortemPrompt(source);
  assert.match(prompt, /Source activity/);
  assert.match(prompt, /Source narration/);

  assert.equal(pruneWhile("running"), 0);
  assert.ok(store.listEvents(source).some(e => e.message === "Source activity"));

  assert.equal(pruneWhile("done"), 2, "a finished post-mortem no longer holds the history");
  assert.equal(store.listEvents(source).some(e => e.message === "Source activity"), false);
});

test("retention: a retried post-mortem protects its source while an earlier attempt has finished", t => {
  const { store, task, ageEvents } = setup(t);
  const source = task("merged");
  store.addEvent(source, "tool", "Source activity");
  ageEvents();
  const review = () => store.createTask({ kind: "maintenance", title: "Post-mortem", brief: "", repoId: null, autonomy: "observe", postmortemOf: source });
  store.updateTask(review().id, { status: "failed", finishedAt: old });
  review();
  assert.equal(store.pruneTaskHistory(cutoff, 30), 0);
  assert.ok(store.listEvents(source).some(e => e.message === "Source activity"));
});

test("retention: deletion is bounded and continues in a later sweep", t => {
  const { store, task, ageEvents } = setup(t);
  const id = task();
  store.db.transaction(() => {
    for (let i = 0; i < 5001; i++) store.addEvent(id, "tool", "Output");
  })();
  ageEvents();
  assert.equal(store.pruneTaskHistory(cutoff, 30), 5000);
  assert.equal(store.pruneTaskHistory(cutoff, 30), 1);
  assert.equal(store.pruneTaskHistory(cutoff, 30), 0);
});

test("retention: hourly maintenance converts legacy storage once and reacts to settings changes", t => {
  const { store, task, ageEvents } = setup(t, true);
  const id = task();
  store.addEvent(id, "tool", "Output");
  ageEvents();
  const logs: string[] = [];
  const maintenance = new StorageMaintenance(store, message => logs.push(message));
  const actions = new OperatorActions(store);
  maintenance.tick(clock);
  actions.configureRetention({ finishedTaskDays: 30 });
  maintenance.tick(clock);
  assert.equal(store.db.pragma("auto_vacuum", { simple: true }), 2);
  assert.equal(store.listEvents(id).filter(e => e.type === "tool").length, 0);
  assert.match(logs[0]!, /removed 1 routine events/);
  assert.ok(logs.every(message => !message.includes("failed")), logs.join("\n"));
  store.addEvent(id, "tool", "More output");
  ageEvents();
  maintenance.tick(clock + 1);
  assert.ok(store.listEvents(id).some(e => e.type === "tool"), "hourly throttle");
  maintenance.tick(clock + 3_600_000);
  assert.ok(!store.listEvents(id).some(e => e.type === "tool"));
  actions.configureRetention({ finishedTaskDays: null });
  store.addEvent(id, "tool", "Keep after disabling");
  ageEvents();
  maintenance.tick(clock + 2 * 3_600_000);
  assert.ok(store.listEvents(id).some(e => e.type === "tool"));
});

test("retention: new databases use incremental auto-vacuum without an opt-in rewrite", t => {
  const { store } = setup(t);
  assert.equal(store.db.pragma("auto_vacuum", { simple: true }), 2);
});

test("retention: incremental vacuum reclaims freed database pages", t => {
  const { store, task, ageEvents } = setup(t);
  const id = task();
  store.db.transaction(() => {
    for (let i = 0; i < 500; i++) store.addEvent(id, "tool", "x".repeat(12_000));
  })();
  ageEvents();
  store.pruneTaskHistory(cutoff, 30);
  const freeBefore = Number(store.db.pragma("freelist_count", { simple: true }));
  const pagesBefore = Number(store.db.pragma("page_count", { simple: true }));
  assert.ok(freeBefore > 1000, "fixture must free enough pages for bounded reclamation");
  store.vacuumHistory();
  const freeAfter = Number(store.db.pragma("freelist_count", { simple: true }));
  assert.ok(freeAfter > 0 && freeAfter < freeBefore, "later sweeps can reclaim the remaining free pages");
  assert.ok(Number(store.db.pragma("page_count", { simple: true })) < pagesBefore);
});

test("retention: removes retry orphans while preserving report references, new copies and active tasks", t => {
  const { root, store, task } = setup(t);
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "view.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const id = task();
  const retain = (taskId: string) => retainScreenshots(taskId, worktree, [{ path: "view.png", caption: "View" }], message => assert.fail(message))[0]!;
  const first = retain(id);
  const second = retain(id);
  const pendingCopy = retain(id);
  utimesSync(screenshotPath(id, pendingCopy.path)!, new Date(clock), new Date(clock));
  store.updateTask(id, { report: { summary: "Retry", changedFiles: [], findings: [], screenshots: [second] } });
  const active = [task("queued"), task("running"), task("merging"), task("cancelled")];
  store.startRun({ taskId: active[3]!, kind: "work", agentId: null, driver: "test" });
  const activeImages = active.map(taskId => ({ taskId, image: retain(taskId) }));
  for (const path of [screenshotPath(id, first.path)!, screenshotPath(id, second.path)!,
    ...activeImages.map(({ taskId, image }) => screenshotPath(taskId, image.path)!)]) {
    utimesSync(path, new Date(old), new Date(old));
  }
  // Attachment cleanup is independent of task-history age.
  const recentTask = task("needs_review", new Date(clock).toISOString());
  const recentOrphan = retain(recentTask);
  utimesSync(screenshotPath(recentTask, recentOrphan.path)!, new Date(old), new Date(old));
  assert.equal(pruneOrphanScreenshots(store, clock), 2);
  assert.equal(existsSync(screenshotPath(id, first.path)!), false);
  assert.equal(existsSync(screenshotPath(recentTask, recentOrphan.path)!), false);
  assert.ok(existsSync(screenshotPath(id, second.path)!));
  assert.ok(existsSync(screenshotPath(id, pendingCopy.path)!));
  for (const { taskId, image } of activeImages) assert.ok(existsSync(screenshotPath(taskId, image.path)!));
  assert.equal(pruneOrphanScreenshots(store, clock), 0);
});

test("retention: attachment cleanup skips unexpected files and directory/file symlinks", t => {
  const { root, store, task } = setup(t);
  const id = task();
  const directory = join(root, "attachments", id);
  mkdirSync(directory, { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  const name = "12345678-1234-1234-1234-123456789abc.png";
  const external = join(outside, name);
  writeFileSync(external, "keep");
  utimesSync(external, new Date(old), new Date(old));
  symlinkSync(external, join(directory, name));
  symlinkSync(outside, join(root, "attachments", "t-linked"));
  writeFileSync(join(directory, "unknown.txt"), "keep");
  assert.equal(pruneOrphanScreenshots(store), 0);
  assert.ok(existsSync(external));
  assert.ok(existsSync(join(directory, "unknown.txt")));
  rmSync(join(root, "attachments"), { recursive: true });
  symlinkSync(outside, join(root, "attachments"));
  assert.equal(pruneOrphanScreenshots(store), 0, "root directory symlinks are also skipped");
  assert.ok(existsSync(external));
});

test("retention API: show, enable and disable; malformed policies save nothing", async t => {
  const { store } = setup(t);
  const app = createApp(store);
  assert.deepEqual(await (await app.request("/api/factory/retention")).json(), { finishedTaskDays: null });
  const post = (body: string) => app.request("/api/factory/retention", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal((await post('{"finishedTaskDays":30}')).status, 200);
  for (const body of ["{", "null", "[]", "{}", ...[0, -1, 1.5, 36501, "30", false, {}].map(finishedTaskDays => JSON.stringify({ finishedTaskDays }))]) {
    assert.equal((await post(body)).status, 400, body);
    assert.deepEqual(store.retentionSettings(), { finishedTaskDays: 30 }, body);
  }
  assert.equal((await post('{"finishedTaskDays":null}')).status, 200);
  assert.deepEqual(store.retentionSettings(), { finishedTaskDays: null });
});
