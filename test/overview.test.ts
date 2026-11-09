import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "@crane/storage";
import { createApp } from "../src/server/app.js";
import type { BlockedCall, Overview } from "@crane/contracts";

const FACTORY: Overview["factory"] = {
  running: false, paused: false, driver: "x", factoryOutdated: false, uiOutdated: false, uiBuild: null, uiCommit: null,
};

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "crane-overview-")), "t.db");

function seeded(store: Store) {
  const repo = store.addRepo({ path: "/repo" });
  const task = (title = "Task") => store.createTask({ kind: "maintenance", title, brief: "", repoId: repo.id, autonomy: "propose" });
  const refuse = (taskId: string, ...rules: string[]) =>
    store.addEvent(taskId, "blocked", "Refused", { tool: "Bash", command: "x", rules } satisfies BlockedCall);
  return { repo, task, refuse };
}

/** The plan SQLite chooses for each statement the overview runs. Parameter values don't affect it. */
function overviewPlans(t: TestContext, store: Store): { sql: string; plan: string[] }[] {
  const prepare = t.mock.method(store.db, "prepare");
  store.overview(FACTORY);
  const statements = [...new Set(prepare.mock.calls.map((call) => call.arguments[0] as string))];
  prepare.mock.restore();
  return statements.map((sql) => {
    const params = (sql.match(/\?/g) ?? []).map(() => null);
    const rows = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
    return { sql, plan: rows.map((r) => r.detail) };
  });
}

test("overview: polling never walks the events table or reads rows just to filter and sort", (t) => {
  const store = new Store(":memory:");
  try {
    const { task, refuse } = seeded(store);
    refuse(task().id, "Bash(curl:*)");
    const plans = overviewPlans(t, store);
    const planFor = (fragment: string) => {
      const found = plans.find((p) => p.sql.includes(fragment));
      assert.ok(found, `the overview still runs a statement with ${fragment}`);
      return found.plan.join("\n");
    };

    for (const { sql, plan } of plans) {
      for (const line of plan) {
        assert.doesNotMatch(line, /^SCAN (events|e\d?)$/, `whole-table walk in: ${sql}`);
      }
    }
    assert.match(planFor("substr(ts, 1, 13)"), /COVERING INDEX events_activity/);
    assert.match(planFor("substr(finished_at, 1, 13)"), /COVERING INDEX tasks_status_times/);
    assert.match(planFor("finished_at < ?"), /COVERING INDEX tasks_status_times/);
    assert.match(planFor("COUNT(*) AS n, MAX(id)"), /COVERING INDEX events_blocked/);
    assert.match(planFor("MAX(e.id)"), /USING INDEX events_blocked/);
    // needsReview, inFlight and recent: the page comes from the index, and only its rows are fetched.
    const lists = plans.filter((p) => p.sql.includes("page_rowid"));
    assert.equal(lists.length, 3);
    for (const { plan } of lists) assert.match(plan.join("\n"), /SEARCH tasks USING COVERING INDEX tasks_status_times/);
  } finally { store.close(); }
});

test("overview: a store from before these indexes gains them and drops the one they replace", () => {
  const file = tmpFile();
  new Store(file).close();
  const old = new Database(file);
  old.exec(`DROP INDEX tasks_status_times; DROP INDEX events_activity; DROP INDEX events_blocked;
            CREATE INDEX tasks_status ON tasks(status);`);
  old.close();

  const store = new Store(file);
  try {
    const names = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    for (const name of ["tasks_status_times", "events_activity", "events_blocked"]) assert.ok(names.includes(name), name);
    assert.ok(!names.includes("tasks_status"));
  } finally { store.close(); }
});

test("overview: counts activity and shipped tasks in the hour they happened", () => {
  const store = new Store(":memory:");
  try {
    const { task } = seeded(store);
    const a = task();
    const insert = store.db.prepare("INSERT INTO events(task_id, ts, type, message) VALUES(?, ?, ?, 'x')");
    const hours = (n: number) => new Date(Date.now() - n * 3600 * 1000).toISOString();
    const hourOf = (ts: string) => `${ts.slice(0, 13)}:00:00.000Z`;

    const threeHoursAgo = hours(3);
    insert.run(a.id, threeHoursAgo, "tool");
    insert.run(a.id, threeHoursAgo, "note");
    insert.run(a.id, threeHoursAgo, "finding");
    insert.run(a.id, threeHoursAgo, "status"); // Not activity.
    insert.run(a.id, hours(8 * 24), "tool"); // Before the window.
    const shipped = task();
    store.updateTask(shipped.id, { status: "merged", finishedAt: threeHoursAgo });
    const failed = task();
    store.updateTask(failed.id, { status: "failed", finishedAt: threeHoursAgo });

    const activity = store.overview(FACTORY).activity;
    const bucket = activity.find((b) => b.t === hourOf(threeHoursAgo));
    assert.deepEqual(bucket, { t: hourOf(threeHoursAgo), done: 1, events: 3 });
    assert.equal(activity.length, 7 * 24 + 1, "one bucket per hour, the current one included");
    assert.deepEqual(activity.map((b) => b.t), activity.map((b) => b.t).sort(), "oldest first");
    assert.ok(activity.every((b) => /^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/.test(b.t)));
    assert.equal(activity.reduce((n, b) => n + b.done, 0), 1);
  } finally { store.close(); }
});

test("task lists: newest first, keep to the limit, and order tasks created in the same instant", () => {
  const store = new Store(":memory:");
  try {
    const { repo, task } = seeded(store);
    const other = store.addRepo({ path: "/other" });
    const stamp = store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const created = task(`Task ${i}`);
      store.updateTask(created.id, { status: i % 2 ? "merged" : "failed" });
      stamp.run(`2026-01-01T00:00:${String(i % 3).padStart(2, "0")}.000Z`, created.id);
      ids.push(created.id);
    }
    const elsewhere = store.createTask({ kind: "maintenance", title: "Elsewhere", brief: "", repoId: other.id, autonomy: "propose" });
    stamp.run("2020-01-01T00:00:00.000Z", elsewhere.id);

    // i % 3 == 2 is newest; within each second, the later insert comes first.
    const expected = [11, 8, 5, 2, 10, 7, 4, 1, 9, 6, 3, 0].map((i) => ids[i]);
    const finished = store.listTasks({ status: ["merged", "failed"] });
    assert.deepEqual(finished.map((x) => x.id), expected);
    assert.equal(finished[0]!.title, "Task 11", "the whole task comes back");
    assert.deepEqual(store.listTasks({ status: ["merged", "failed"], limit: 3 }).map((x) => x.id), expected.slice(0, 3));
    assert.deepEqual(store.listTasks({ status: ["merged"], limit: 2 }).map((x) => x.id), [ids[11], ids[5]]);
    assert.deepEqual(store.listTasks({ repoId: other.id }).map((x) => x.id), [elsewhere.id]);
    assert.equal(store.listTasks({ repoId: repo.id, status: ["queued"] }).length, 0);
    assert.equal(store.listTasks().at(-1)!.id, elsewhere.id);
  } finally { store.close(); }
});

test("blocked tools: the latest refusal stays one row, whichever rule and repo are asked about", () => {
  const store = new Store(":memory:");
  try {
    const { task, refuse } = seeded(store);
    const [a, b, c] = [task(), task(), task()];
    const first = refuse(a.id, "Bash(curl:*)", "Bash(npm ci:*)");
    const second = refuse(b.id, "Bash(curl:*)");
    refuse(c.id, "Bash(npm ci:*)");
    const curl = store.blockedTools().find((x) => x.rule === "Bash(curl:*)")!;
    assert.equal(curl.tasks, 2);
    assert.equal(curl.times, 2);
    assert.equal(curl.lastTaskId, b.id, "the most recent refusal's task");
    assert.equal(curl.lastAt, second.ts);
    assert.ok(first.ts <= second.ts);
    const npm = store.blockedTools().find((x) => x.rule === "Bash(npm ci:*)")!;
    assert.equal(npm.lastTaskId, c.id);
  } finally { store.close(); }
});

test("blocked tools: reuses its totals only while no refusal has changed, even one from another process", (t) => {
  const file = tmpFile();
  const store = new Store(file);
  const otherProcess = new Store(file);
  try {
    const { repo, task, refuse } = seeded(store);
    const [a, b] = [task(), task()];
    refuse(a.id, "Bash(curl:*)");
    assert.deepEqual(store.blockedTools().map((x) => x.times), [1]);

    const prepare = t.mock.method(store.db, "prepare");
    const totalsRuns = () => prepare.mock.calls.filter((call) => (call.arguments[0] as string).includes("MAX(e.id)")).length;
    store.blockedTools();
    store.blockedTools({ minTasks: 2 });
    assert.equal(totalsRuns(), 0, "nothing changed, so nothing is added up again");

    // Other kinds of events don't count as a change.
    store.addEvent(a.id, "tool", "Ran something");
    store.blockedTools();
    assert.equal(totalsRuns(), 0);

    // Another process's refusal is seen at once.
    otherProcess.addEvent(b.id, "blocked", "Refused", { tool: "Bash", command: "x", rules: ["Bash(curl:*)"] });
    assert.deepEqual(store.blockedTools().map((x) => [x.tasks, x.times, x.lastTaskId]), [[2, 2, b.id]]);
    assert.equal(totalsRuns(), 1);

    // A removed refusal is seen too, though the latest id hasn't moved.
    store.db.prepare("DELETE FROM events WHERE id = (SELECT MIN(id) FROM events WHERE type = 'blocked')").run();
    assert.deepEqual(store.blockedTools().map((x) => [x.tasks, x.times]), [[1, 1]]);
    assert.equal(totalsRuns(), 2);

    // Decisions aren't part of the totals, so they apply straight away.
    prepare.mock.restore();
    store.setRepoTools(repo.id, { allowed: ["Bash(curl:*)"], keptBlocked: [] });
    assert.deepEqual(store.blockedTools(), []);
  } finally {
    store.close();
    otherProcess.close();
  }
});

test("blocked tools: filters on the shared totals by repo, task and how widespread", () => {
  const store = new Store(":memory:");
  try {
    const { repo, task, refuse } = seeded(store);
    const other = store.addRepo({ path: "/other" });
    const [a, b] = [task(), task()];
    const elsewhere = store.createTask({ kind: "maintenance", title: "Other", brief: "", repoId: other.id, autonomy: "propose" });
    refuse(a.id, "Bash(curl:*)", "Bash(npm ci:*)");
    refuse(b.id, "Bash(curl:*)");
    refuse(elsewhere.id, "Bash(curl:*)");
    const summary = (list: ReturnType<Store["blockedTools"]>) => list.map((x) => [x.repoId, x.rule, x.tasks]);

    assert.deepEqual(summary(store.blockedTools({ minTasks: 2 })), [[repo.id, "Bash(curl:*)", 2]]);
    assert.deepEqual(summary(store.blockedTools({ repoId: other.id })), [[other.id, "Bash(curl:*)", 1]]);
    assert.deepEqual(summary(store.blockedTools({ taskId: b.id, repoId: repo.id })), [[repo.id, "Bash(curl:*)", 2]]);
    assert.deepEqual(summary(store.blockedTools({ taskId: "t-unknown" })), []);
    assert.equal(store.blockedTools({ minTasks: Number("many") }).length, 0, "a bad minimum matches nothing");
  } finally { store.close(); }
});

test("api: tabs share one overview for a moment, and actions show immediately", async (t) => {
  const store = new Store(":memory:");
  try {
    const { task } = seeded(store);
    const app = createApp(store);
    const computed = t.mock.method(store, "overview");
    const read = async () => {
      const response = await app.request("/api/overview");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
      return await response.json() as Overview;
    };

    const first = await read();
    assert.deepEqual(await read(), first);
    assert.equal(computed.mock.callCount(), 1, "a second tab gets the same answer");

    const paused = await app.request("/api/factory/pause", { method: "POST" });
    assert.equal(paused.status, 200);
    assert.equal((await read()).factory.paused, true, "an action shows on the very next poll");
    assert.equal(computed.mock.callCount(), 2);

    const failed = await app.request("/api/tasks/t-unknown/merge", { method: "POST" });
    assert.equal(failed.status, 400);
    await read();
    assert.equal(computed.mock.callCount(), 3, "a failed action may have changed something before it failed");

    // Work the factory does itself shows within the sharing window.
    const queued = task("Started by the factory");
    assert.ok(!(await read()).inFlight.some((x) => x.id === queued.id), "still shared");
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.ok((await read()).inFlight.some((x) => x.id === queued.id));
    assert.equal(computed.mock.callCount(), 4);
  } finally { store.close(); }
});
