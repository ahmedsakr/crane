import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "@crane/storage";

const AT = "2026-11-21T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "crane-runners-"));
  return { dir, file: join(dir, "crane.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function assertRunnerSchema(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    assert.ok(tables.includes("runners") && tables.includes("runner_jobs"), tables.join(", "));
    for (const table of ["tasks", "runs", "crew_schedules"]) assert.ok(columns(db, table).includes("runner_id"), `${table}.runner_id`);
    assert.deepEqual(columns(db, "runners"), ["id", "operator_id", "name", "token_hash", "capacity", "drivers", "version",
      "created_at", "last_seen_at", "revoked_at"]);
    assert.deepEqual(columns(db, "runner_jobs"), ["id", "task_id", "runner_id", "kind", "payload", "state", "lease_expires_at",
      "session_id", "result", "created_at", "claimed_at", "finished_at"]);
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runner_jobs_runner_state'").get() as { sql: string };
    assert.match(index.sql, /runner_jobs\(runner_id, state\)/);
  } finally { db.close(); }
}

function setup(file = ":memory:") {
  const store = new Store(file);
  const owner = store.access.createOperator({ username: "robin", name: "Robin", role: "operator", passwordHash: "x", at: AT });
  const runner = store.runners.create({ operatorId: owner.id, name: "laptop", tokenHash: "digest-laptop", at: AT });
  const repo = store.addRepo({ path: "/repo" });
  const task = (title: string, runnerId: string | null = null) =>
    store.createTask({ kind: "maintenance", title, brief: "", repoId: repo.id, autonomy: "observe", runnerId });
  return { store, owner, runner, task };
}

test("runners: a fresh database has the container tables and columns", () => {
  const { file, cleanup } = tempDb();
  try {
    new Store(file).close();
    assertRunnerSchema(file);
  } finally { cleanup(); }
});

test("runners: opening an older database adds the container tables and columns, keeping its tasks", () => {
  const { file, cleanup } = tempDb();
  try {
    const first = new Store(file);
    const kept = first.createTask({ kind: "maintenance", title: "Kept", brief: "", repoId: null, autonomy: "observe" });
    first.close();
    const legacy = new Database(file);
    legacy.exec(`DROP TABLE runner_jobs; DROP TABLE runners; DROP INDEX tasks_runner;
      ALTER TABLE tasks DROP COLUMN runner_id; ALTER TABLE runs DROP COLUMN runner_id;
      ALTER TABLE crew_schedules DROP COLUMN runner_id;`);
    legacy.close();
    const store = new Store(file);
    try {
      assert.equal(store.getTask(kept.id)?.runnerId, null);
    } finally { store.close(); }
    assertRunnerSchema(file);
  } finally { cleanup(); }
});

test("runners: tasks and runs record their container", () => {
  const { store, runner, task } = setup();
  try {
    const routed = task("Routed", runner.id);
    assert.equal(store.getTask(routed.id)?.runnerId, runner.id);
    const local = task("Local");
    assert.equal(local.runnerId, null);
    store.updateTask(local.id, { runnerId: runner.id });
    assert.equal(store.getTask(local.id)?.runnerId, runner.id);
    assert.equal(store.lastWorkRunner(routed.id), null);
    store.startRun({ taskId: routed.id, kind: "work", agentId: null, driver: "claude-code", runnerId: runner.id });
    assert.equal(store.lastWorkRunner(routed.id), runner.id);
    store.startRun({ taskId: routed.id, kind: "resolve_conflicts", agentId: null, driver: "claude-code" });
    assert.equal(store.lastWorkRunner(routed.id), runner.id, "only work runs own the session");
    store.startRun({ taskId: routed.id, kind: "work", agentId: null, driver: "claude-code" });
    assert.equal(store.lastWorkRunner(routed.id), null, "the latest work run was on the crew");
  } finally { store.close(); }
});

test("runners: the crew never claims routed work, and a container claims only its own", () => {
  const { store, owner, runner, task } = setup();
  try {
    const other = store.runners.create({ operatorId: owner.id, name: "desktop", tokenHash: "digest-desktop", at: AT });
    const mine = task("Mine", runner.id);
    const theirs = task("Theirs", other.id);
    const local = task("Local");
    assert.deepEqual(store.pendingWork(), { queued: true, merging: false, runners: [runner.id, other.id].sort() });
    assert.equal(store.queuedForAnyone(), 1, "routed work doesn't call for more crew");
    assert.equal(store.claimNextTask("a-one")?.id, local.id);
    assert.equal(store.claimNextTask("a-one"), null);
    assert.equal(store.claimNextTask("a-one", { onlyPostmortems: true }), null);
    assert.equal(store.pendingWork().queued, false);
    const claimed = store.claimNextRunnerTask(runner.id, "lane-1");
    assert.equal(claimed?.id, mine.id);
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.agentId, "lane-1");
    assert.equal(store.claimNextRunnerTask(runner.id, "lane-1"), null);
    assert.equal(store.claimNextRunnerTask(other.id, "lane-2")?.id, theirs.id);
    assert.deepEqual(store.pendingWork().runners, []);
  } finally { store.close(); }
});

test("runners: a container's claims keep due times, prerequisites and queue order", () => {
  const { store, runner, task } = setup();
  try {
    const first = task("First", runner.id);
    store.setStatus(first.id, "needs_review");
    const held = store.createTask({ kind: "maintenance", title: "Held", brief: "", repoId: null, autonomy: "observe",
      runnerId: runner.id, prerequisites: [first.id] });
    const future = store.createTask({ kind: "maintenance", title: "Future", brief: "", repoId: null, autonomy: "observe",
      runnerId: runner.id, scheduledAt: "2099-01-01T00:00:00.000Z" });
    const older = task("Older", runner.id);
    const newer = task("Newer", runner.id);
    store.moveQueuedTask(newer.id, older.id);
    assert.deepEqual([store.claimNextRunnerTask(runner.id, "lane")?.id, store.claimNextRunnerTask(runner.id, "lane")?.id],
      [newer.id, older.id]);
    assert.equal(store.claimNextRunnerTask(runner.id, "lane"), null, `${held.id} waits for ${first.id}; ${future.id} isn't due`);
  } finally { store.close(); }
});

test("runners: removing an operator removes their containers, and their jobs stay with their tasks", () => {
  const { store, owner, runner, task } = setup();
  try {
    const job = store.runners.createJob({ taskId: task("Routed", runner.id).id, runnerId: runner.id, kind: "work", payload: {}, at: AT });
    assert.equal(store.access.deleteOperator(owner.id), true);
    assert.equal(store.runners.byId(runner.id), null);
    assert.equal(store.runners.byTokenHash("digest-laptop"), null);
    assert.deepEqual(store.runners.listAll(), []);
    assert.equal(store.runners.job(job.id)?.taskId, job.taskId);
  } finally { store.close(); }
});

test("runners: lists and records never carry a token digest; only byTokenHash reads by one", () => {
  const { store, owner, runner } = setup();
  try {
    const live = Date.parse(AT) + 1000;
    store.runners.touch(runner.id, AT, { drivers: ["claude-code", "bogus" as "codex"], capacity: 2, version: "1.2.3" });
    const [summary] = store.runners.listFor(owner.id, live);
    assert.deepEqual(summary, { id: runner.id, name: "laptop", ownerId: owner.id, ownerName: "Robin", capacity: 2,
      drivers: ["claude-code"], online: true, lastSeenAt: AT, createdAt: AT, busy: 0 });
    const shown = JSON.stringify([store.runners.listAll(live), store.runners.listFor(owner.id), store.runners.byId(runner.id),
      store.runners.byTokenHash("digest-laptop"), runner]);
    assert.doesNotMatch(shown, /digest-|token/i);
    assert.equal(store.runners.byTokenHash("digest-laptop")?.id, runner.id);
    assert.equal(store.runners.rotateToken(runner.id, "digest-rotated"), true);
    assert.equal(store.runners.byTokenHash("digest-laptop"), null, "the old token stops working");
    assert.equal(store.runners.byTokenHash("digest-rotated")?.id, runner.id);
    assert.equal(store.runners.listFor(owner.id, Date.parse(AT) + 120_000)[0]?.online, false);
  } finally { store.close(); }
});

test("runners: renaming, capacity, revoking and removing", () => {
  const { store, owner, runner, task } = setup();
  try {
    assert.equal(store.runners.rename(runner.id, "studio"), true);
    assert.equal(store.runners.setCapacity(runner.id, 3), true);
    assert.deepEqual([store.runners.byId(runner.id)?.name, store.runners.byId(runner.id)?.capacity], ["studio", 3]);
    const job = store.runners.createJob({ taskId: task("Routed", runner.id).id, runnerId: runner.id, kind: "work", payload: {}, at: AT });
    assert.equal(store.runners.revoke(runner.id, AT), true);
    assert.equal(store.runners.revoke(runner.id, AT), false);
    assert.equal(store.runners.byTokenHash("digest-laptop"), null);
    assert.equal(store.runners.byId(runner.id)?.revokedAt, AT);
    assert.deepEqual(store.runners.listFor(owner.id), []);
    assert.equal(store.runners.job(job.id)?.state, "cancelled");
    assert.equal(store.runners.touch(runner.id, AT), false, "a revoked container can't check in");
    assert.equal(store.runners.claimJob(runner.id, AT), null);
    assert.equal(store.runners.remove(runner.id, AT), true);
    assert.equal(store.runners.byId(runner.id), null);
  } finally { store.close(); }
});

test("runners: jobs are claimed oldest first within capacity, and finish once", () => {
  const { store, runner, task } = setup();
  try {
    const taskId = task("Routed", runner.id).id;
    const first = store.runners.createJob({ taskId, runnerId: runner.id, kind: "work", payload: { base: "abc" }, at: AT });
    const second = store.runners.createJob({ taskId, runnerId: runner.id, kind: "observe", payload: {}, at: later(1) });
    const claimed = store.runners.claimJob(runner.id, AT);
    assert.deepEqual([claimed?.id, claimed?.state, claimed?.payload, claimed?.leaseExpiresAt], [first.id, "claimed", { base: "abc" }, later(300)]);
    assert.equal(store.runners.claimJob(runner.id, AT), null, "capacity 1 is busy");
    assert.equal(store.runners.listAll()[0]?.busy, 1);
    assert.equal(store.runners.openJobFor(taskId)?.id, second.id, "the newest open job");
    assert.equal(store.runners.recordSession(first.id, "session-1"), true);
    assert.equal(store.runners.extendLease(first.id, "c-other", later(60)), false, "only its own container renews it");
    assert.equal(store.runners.extendLease(first.id, runner.id, later(60)), true);
    assert.equal(store.runners.job(first.id)?.leaseExpiresAt, later(360));
    const result = { outcome: "succeeded" as const, finalText: "done", sessionId: "session-1" };
    assert.equal(store.runners.finishJob(first.id, "returned", result, later(70)), true);
    assert.equal(store.runners.finishJob(first.id, "failed", null), false);
    assert.deepEqual([store.runners.job(first.id)?.state, store.runners.job(first.id)?.result, store.runners.job(first.id)?.sessionId],
      ["returned", result, "session-1"]);
    assert.equal(store.runners.extendLease(first.id, runner.id, later(80)), false);
    assert.equal(store.runners.claimJob(runner.id, later(80))?.id, second.id);
    assert.equal(store.runners.cancelJobsFor(taskId), 1);
    assert.equal(store.runners.openJobFor(taskId), null);
  } finally { store.close(); }
});

test("runners: expired leases are returned once and their jobs stay closed", () => {
  const { store, runner, task } = setup();
  try {
    store.runners.setCapacity(runner.id, 2);
    const taskId = task("Routed", runner.id).id;
    const stale = store.runners.createJob({ taskId, runnerId: runner.id, kind: "work", payload: {}, at: AT });
    const fresh = store.runners.createJob({ taskId, runnerId: runner.id, kind: "work", payload: {}, at: later(1) });
    store.runners.claimJob(runner.id, AT);
    store.runners.claimJob(runner.id, later(200));
    assert.deepEqual(store.runners.expireLeases(later(299)), []);
    assert.deepEqual(store.runners.expireLeases(later(300)).map((j) => [j.id, j.state]), [[stale.id, "expired"]]);
    assert.deepEqual(store.runners.expireLeases(later(300)), []);
    assert.equal(store.runners.finishJob(stale.id, "returned", null), false, "a late return can't reopen it");
    assert.equal(store.runners.job(fresh.id)?.state, "claimed");
  } finally { store.close(); }
});

test("runners: two processes claiming at once never share a job or exceed capacity", () => {
  const { file, cleanup } = tempDb();
  const { store, runner, task } = setup(file);
  const other = new Store(file);
  try {
    store.runners.setCapacity(runner.id, 2);
    const taskId = task("Routed", runner.id).id;
    for (let i = 0; i < 3; i++) store.runners.createJob({ taskId, runnerId: runner.id, kind: "work", payload: { i }, at: later(i) });
    // The other process claims between this one's read and its write, as it would under contention.
    const prepare = store.db.prepare.bind(store.db);
    let raced = "";
    store.db.prepare = ((sql: string) => {
      if (!raced && sql.trimStart().startsWith("UPDATE runner_jobs SET state = 'claimed'")) {
        try { raced = other.runners.claimJob(runner.id, AT)?.id ?? "nothing"; } catch (err) { raced = (err as { code?: string }).code ?? "failed"; }
      }
      return prepare(sql);
    }) as typeof store.db.prepare;
    other.db.pragma("busy_timeout = 0");
    const mine = store.runners.claimJob(runner.id, AT);
    assert.equal(raced, "SQLITE_BUSY", "the claim holds the write lock from its first read");
    const theirs = other.runners.claimJob(runner.id, AT);
    assert.notEqual(mine?.id, theirs?.id);
    assert.equal(store.runners.claimJob(runner.id, AT), null, "capacity 2 is full");
    assert.equal(other.runners.claimJob(runner.id, AT), null);
  } finally { other.close(); store.close(); cleanup(); }
});
