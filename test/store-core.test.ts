import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@crane/storage";
import { temporaryRoot } from "./support/fixtures.ts";

test("store: extraction preserves schema and persisted rows across ordinary opens", (t) => {
  const file = join(temporaryRoot(t, "crane-storage-reopen-"), "crane.db");
  const store = new Store(file);
  const repo = store.addRepo({ path: "/code/persisted" });
  const task = store.createTask({ kind: "maintenance", title: "Persisted", brief: "Keep", repoId: repo.id, autonomy: "observe" });
  store.access.createOperator({ username: "robin", name: "Robin", role: "admin", passwordHash: "digest", at: "2026-01-01T00:00:00Z" });
  store.claimNextTask("a-1");
  store.addEvent(task.id, "note", "Persist this event");
  store.close();
  const snapshot = () => {
    const db = new Database(file, { readonly: true });
    try {
      const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      const rows = tables.map(({ name }) => db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all());
      return { schema, rows, version: db.pragma("user_version"), vacuum: db.pragma("auto_vacuum") };
    } finally {
      db.close();
    }
  };
  const before = snapshot();
  const reopened = new Store(file);
  assert.equal(reopened.getTask(task.id)?.title, "Persisted");
  assert.equal(reopened.access.countOperators(), 1);
  reopened.close();
  assert.deepEqual(snapshot(), before);
});

test("store: tasks are claimed once, oldest first", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "crane-")), "t.db"));
  const r = store.addRepo({ path: "/code/x" });
  const a = store.createTask({ kind: "maintenance", title: "first", brief: "", repoId: r.id, autonomy: "observe" });
  store.createTask({ kind: "maintenance", title: "second", brief: "", repoId: r.id, autonomy: "observe" });
  assert.equal(store.claimNextTask("a-1")?.id, a.id);
  assert.equal(store.claimNextTask("a-2")?.title, "second");
  assert.equal(store.claimNextTask("a-3"), null);
  assert.equal(store.getTask(a.id)?.status, "running");
  store.close();
});

test("store: new tasks get a t- id and can be found without the prefix", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "crane-")), "t.db"));
  const r = store.addRepo({ path: "/code/x" });
  const t = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: r.id, autonomy: "observe" });
  assert.match(t.id, /^t-/);
  assert.equal(store.getTask(t.id.slice(2))?.id, t.id);
  store.close();
});

test("store: a database from before the rename keeps its missions as tasks", () => {
  const file = join(mkdtempSync(join(tmpdir(), "crane-")), "old.db");
  const old = new Database(file);
  old.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL DEFAULT 'main', is_factory INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL);
    CREATE TABLE missions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
      repo_id TEXT REFERENCES repos(id), autonomy TEXT NOT NULL, status TEXT NOT NULL, agent_id TEXT, branch TEXT,
      worktree TEXT, report TEXT, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE INDEX missions_status ON missions(status);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id),
      ts TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
    CREATE INDEX events_mission ON events(mission_id, id);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle', mission_id TEXT,
      driver TEXT NOT NULL, missions_completed INTEGER NOT NULL DEFAULT 0, last_active_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO repos VALUES ('r-abcd', 'x', '/code/x', 'main', 0, '2026-01-01T00:00:00Z');
    INSERT INTO missions(id, kind, title, brief, repo_id, autonomy, status, created_at)
      VALUES ('m-old123', 'maintenance', 'Old work', '', 'r-abcd', 'observe', 'needs_review', '2026-01-01T00:00:00Z');
    INSERT INTO events(mission_id, ts, type, message) VALUES ('m-old123', '2026-01-01T00:00:00Z', 'status', 'Queued');
    INSERT INTO agents(id, name, mission_id, driver, missions_completed) VALUES ('a-jib', 'Jib', 'm-old123', 'simulated', 7);
  `);
  old.close();

  const store = new Store(file);
  const t = store.getTask("old123");
  assert.equal(t?.id, "m-old123");
  assert.equal(t?.title, "Old work");
  assert.equal(t?.model, null);
  assert.equal(t?.effort, null);
  assert.equal(store.listEvents("m-old123")[0]?.taskId, "m-old123");
  assert.deepEqual(
    store.listAgents().map((a) => [a.taskId, a.tasksCompleted]),
    [["m-old123", 7]],
  );
  // New work lands in the same table, and events still point at their task.
  const next = store.createTask({ kind: "maintenance", title: "New", brief: "", repoId: "r-abcd", autonomy: "observe" });
  assert.equal(store.listTasks().length, 2);
  assert.equal(store.listEvents(next.id).length, 1);
  assert.equal(store.overview({ running: false, paused: false, driver: "simulated", factoryOutdated: false, uiOutdated: false, uiBuild: null, uiCommit: null }).counts.needs_review, 1);
  store.close();

  // Opening it again is a no-op.
  const again = new Store(file);
  assert.equal(again.listTasks().length, 2);
  again.close();
});
