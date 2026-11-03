import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";

test("task summaries preserve list filters, ordering, limits, and row metadata", () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const other = store.addRepo({ path: "/other" });
    for (let i = 0; i < 205; i++) {
      const task = store.createTask({ kind: "maintenance", title: `Task ${i}`, brief: "Full brief", autonomy: "propose",
        repoId: i % 2 ? repo.id : other.id, assignee: i % 2 ? "a-jib" : null,
        scheduledAt: "2027-01-01T00:00:00.000Z", postmortemOf: i % 2 ? "t-source" : null });
      store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?")
        .run(new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), task.id);
      store.updateTask(task.id, { status: i % 3 ? "running" : "merged",
        branch: `crane/${task.id}`, startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: i % 3 ? null : "2026-01-02T00:00:00.000Z" });
    }
    for (const opts of [{}, { limit: -1 }, { limit: 3 }, { limit: 0 }, { status: [] },
      { status: ["running" as const], repoId: repo.id, assignee: "a-jib", limit: 7 },
      { status: ["queued" as const] }, { repoId: other.id }]) {
      const expected = store.listTasks(opts).map(t => ({
        id: t.id, kind: t.kind, title: t.title, repoId: t.repoId, status: t.status, branch: t.branch,
        assignee: t.assignee, postmortemOf: t.postmortemOf,
        createdAt: t.createdAt, scheduledAt: t.scheduledAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
        reportSummary: null, findingCount: 0, changedFileCount: 0,
      }));
      assert.deepEqual(store.listTaskSummaries(opts), expected);
    }
    assert.equal(store.listTaskSummaries().length, 200);
  } finally { store.close(); }
});

test("task summaries handle empty and legacy reports with missing counts", () => {
  const store = new Store(":memory:");
  try {
    const task = store.createTask({ kind: "maintenance", title: "Report", brief: "", repoId: null, autonomy: "observe" });
    for (const report of [null, { summary: "Empty", findings: [], changedFiles: [] }]) {
      store.updateTask(task.id, { report });
      const summary = store.listTaskSummaries()[0]!;
      assert.equal(summary.reportSummary, report?.summary ?? null);
      assert.equal(summary.findingCount, 0);
      assert.equal(summary.changedFileCount, 0);
    }
    store.db.prepare("UPDATE tasks SET report = ? WHERE id = ?").run(JSON.stringify({ summary: "Legacy" }), task.id);
    const summary = store.listTaskSummaries()[0]!;
    assert.equal(summary.reportSummary, "Legacy");
    assert.equal(summary.findingCount, 0);
    assert.equal(summary.changedFileCount, 0);
  } finally { store.close(); }
});
