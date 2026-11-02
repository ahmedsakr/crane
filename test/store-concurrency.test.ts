import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/core/store.js";

/**
 * Every process opens the same database, so a transaction that reads and then
 * writes must hold the write lock from its start. A deferred one fails at once
 * with SQLITE_BUSY_SNAPSHOT if another process commits between the two, without
 * waiting for busy_timeout.
 */

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "crane-store-")), "crane.db");
  const store = new Store(file);
  const repo = store.addRepo({ path: "/repo" });
  const task = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: repo.id, autonomy: "propose" });
  return { file, store, task };
}

/**
 * Another process tries to commit just before `store` prepares its first
 * `statement`, which is after that transaction's read. It doesn't wait, so a
 * held write lock shows up as SQLITE_BUSY. Returns what it saw.
 */
function otherProcessWritesBefore(file: string, store: Store, statement: string) {
  const other = new Database(file);
  other.pragma("busy_timeout = 0");
  const seen: { outcome: string | null } = { outcome: null };
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string) => {
    if (seen.outcome === null && sql.startsWith(statement)) {
      try {
        other.prepare("INSERT INTO settings(key, value) VALUES('other', '1') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
        seen.outcome = "committed";
      } catch (err) {
        seen.outcome = (err as { code?: string }).code ?? "failed";
      }
    }
    return prepare(sql);
  }) as typeof store.db.prepare;
  return { seen, close: () => other.close() };
}

test("store: claiming a task holds the write lock across its read, so another process can't break it", () => {
  const { file, store, task } = setup();
  const other = otherProcessWritesBefore(file, store, "UPDATE tasks SET status = 'running'");
  try {
    const claimed = store.claimNextTask("a-one");
    assert.equal(other.seen.outcome, "SQLITE_BUSY");
    assert.equal(claimed?.id, task.id);
    assert.equal(claimed?.status, "running");
  } finally {
    other.close();
    store.close();
  }
});

test("store: claiming a merge holds the write lock across its read, so another process can't break it", () => {
  const { file, store, task } = setup();
  store.updateTask(task.id, { status: "merging" });
  const other = otherProcessWritesBefore(file, store, "UPDATE tasks SET agent_id");
  try {
    const claimed = store.claimNextMerge("a-one");
    assert.equal(other.seen.outcome, "SQLITE_BUSY");
    assert.equal(claimed?.id, task.id);
    assert.equal(claimed?.agentId, "a-one");
  } finally {
    other.close();
    store.close();
  }
});

test("store: recording a finished merge holds the write lock across its read, so a landed merge isn't reported as failed", () => {
  const { file, store, task } = setup();
  store.updateTask(task.id, { status: "merging" });
  const other = otherProcessWritesBefore(file, store, "UPDATE tasks SET worktree");
  try {
    const review = store.completeMerge(task.id, "Merged into main", {});
    assert.equal(other.seen.outcome, "SQLITE_BUSY");
    assert.equal(store.getTask(task.id)?.status, "merged");
    assert.ok(review, "its post-mortem is queued with it");
  } finally {
    other.close();
    store.close();
  }
});

test("store: a claim and its event commit together", () => {
  const { store, task } = setup();
  const addEvent = store.addEvent.bind(store);
  store.addEvent = (...args: Parameters<Store["addEvent"]>) => {
    if (args[2] === "Picked up") throw new Error("database or disk is full");
    return addEvent(...args);
  };
  try {
    assert.throws(() => store.claimNextTask("a-one"), /disk is full/);
    assert.equal(store.getTask(task.id)?.status, "queued", "a claim that couldn't be recorded stays in the queue");
  } finally {
    store.close();
  }
});
