import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateAnalytics } from "../packages/storage/src/store/analytics.js";
import type { Row } from "../packages/storage/src/store/rows.js";

function run(taskId: string, finishedAt: number, usd: number, extra: Row = {}): Row {
  return {
    task_id: taskId, title: taskId, status: "merged", kind: "maintenance", repo_id: "repo",
    driver: "claude-code", finished_at: new Date(finishedAt).toISOString(), cost_usd: usd,
    cost_status: "reported", input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4,
    ...extra,
  };
}

test("analytics aggregation needs only rows and preserves daily, task and agent totals", () => {
  const now = new Date(2026, 10, 3, 12).getTime();
  const today = new Date(2026, 10, 3).getTime();
  const yesterday = new Date(2026, 10, 2).getTime();
  const rows = [
    run("old", yesterday - 1, 8),
    run("a", yesterday, 1),
    run("a", today - 1, 2, { driver: "codex" }),
    run("b", today, 3, { driver: "codex", cost_status: "unknown", status: "rejected", repo_id: null }),
    run("free", now, 0),
  ];
  const original = structuredClone(rows);
  const totals = aggregateAnalytics(rows, 2, now);
  assert.deepEqual(rows, original, "aggregation does not mutate its input");
  assert.equal(totals.spendUsd, 6);
  assert.equal(totals.prevSpendUsd, 8);
  assert.equal(totals.runs, 4);
  assert.equal(totals.unknownCostRuns, 1);
  assert.deepEqual(totals.tokens, { input: 4, output: 8, cacheRead: 12, cacheWrite: 16 });
  assert.deepEqual([...totals.daily], [
    [yesterday, { usd: 3, runs: 2 }],
    [today, { usd: 3, runs: 2 }],
  ]);
  assert.deepEqual([...totals.perTask.values()], [
    { id: "a", title: "a", status: "merged", kind: "maintenance", repoId: "repo", usd: 3, runs: 2 },
    { id: "b", title: "b", status: "rejected", kind: "maintenance", repoId: null, usd: 3, runs: 1 },
    { id: "free", title: "free", status: "merged", kind: "maintenance", repoId: "repo", usd: 0, runs: 1 },
  ]);
  assert.deepEqual([...totals.perAgent], [
    ["claude-code", { usd: 1, tasks: new Set(["a", "free"]) }],
    ["codex", { usd: 5, tasks: new Set(["a", "b"]) }],
  ]);
});

test("analytics aggregation keeps empty local days and zero totals", () => {
  const now = new Date(2026, 10, 3, 12).getTime();
  const totals = aggregateAnalytics([], 3, now);
  assert.deepEqual([...totals.daily], [1, 2, 3].map((day) => [
    new Date(2026, 10, day).getTime(), { usd: 0, runs: 0 },
  ]));
  assert.equal(totals.perTask.size, 0);
  assert.equal(totals.perAgent.size, 0);
  assert.equal(totals.spendUsd, 0);
  assert.equal(totals.prevSpendUsd, 0);
  assert.equal(totals.runs, 0);
  assert.equal(totals.unknownCostRuns, 0);
});
