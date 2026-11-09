import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@crane/storage";
import { usageFromResult } from "../packages/agent-drivers/src/claude-code.js";
import { usageFromTurn } from "../packages/agent-drivers/src/codex.js";
import { Factory } from "../src/factory/orchestrator.js";
import type { AgentDriver, RunContext, RunResult } from "@crane/agent-protocol";
import type { RunUsage } from "@crane/contracts";

const tmpStore = () => new Store(join(mkdtempSync(join(tmpdir(), "crane-cost-")), "t.db"));
const usage = (costUsd: number, extra: Partial<RunUsage> = {}): RunUsage => ({
  costUsd,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 300,
  cacheWriteTokens: 40,
  turns: 3,
  model: "claude-sonnet-5-5",
  ...extra,
});

test("usage: reads Claude Code's result message, summing every model", () => {
  const u = usageFromResult(
    {
      type: "result",
      total_cost_usd: 1.25,
      num_turns: 14,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        "claude-haiku-5-5": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
        "claude-opus-5-5": { inputTokens: 900, outputTokens: 500, cacheReadInputTokens: 7000, cacheCreationInputTokens: 300, costUSD: 1.24 },
      },
    },
    "claude-opus-5-5",
  );
  assert.deepEqual(u, {
    costUsd: 1.25,
    inputTokens: 1000,
    outputTokens: 510,
    cacheReadTokens: 7000,
    cacheWriteTokens: 300,
    turns: 14,
    model: "claude-opus-5-5",
  });
});

test("usage: falls back to the main loop's usage, and to zero for junk", () => {
  const u = usageFromResult(
    { total_cost_usd: "0.5", usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 } },
    "m",
  );
  assert.deepEqual([u.costUsd, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.model], [0.5, 5, 6, 7, 8, "m"]);
  assert.equal(usageFromResult({ total_cost_usd: "nope" }).costUsd, 0);
});

test("runs: a task's cost is the sum of its runs, counted once", () => {
  const store = tmpStore();
  const r = store.addRepo({ path: "/code/x" });
  const t = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: r.id, autonomy: "propose" });
  const a = store.startRun({ taskId: t.id, kind: "work", agentId: "a-jib", driver: "test" });
  store.finishRun(a, "succeeded", usage(1.5));
  const b = store.startRun({ taskId: t.id, kind: "resolve_conflicts", agentId: "a-jib", driver: "test" });
  store.finishRun(b, "failed", usage(0.25));
  store.finishRun(b, "failed", usage(0.25)); // a second close is a no-op
  assert.equal(store.getTask(t.id)?.costUsd, 1.75);
  const runs = store.listRuns(t.id);
  assert.deepEqual(
    runs.map((x) => [x.kind, x.outcome, x.costUsd, x.cacheReadTokens]),
    [
      ["work", "succeeded", 1.5, 300],
      ["resolve_conflicts", "failed", 0.25, 300],
    ],
  );
  store.close();
});

test("runs: ones a dead factory left open close at zero", () => {
  const store = tmpStore();
  const r = store.addRepo({ path: "/code/x" });
  const t = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: r.id, autonomy: "observe" });
  const id = store.startRun({ taskId: t.id, kind: "work", agentId: null, driver: "test" });
  assert.equal(store.closeStaleRuns(), 1);
  store.finishRun(id, "succeeded", usage(9)); // too late: already closed
  assert.equal(store.listRuns(t.id)[0]?.outcome, "cancelled");
  assert.equal(store.getTask(t.id)?.costUsd, 0);
  store.close();
});

test("runs: costs recorded before the ledger existed are carried over", () => {
  const file = join(mkdtempSync(join(tmpdir(), "crane-cost-")), "old.db");
  let store = new Store(file);
  const r = store.addRepo({ path: "/code/x" });
  const paid = store.createTask({ kind: "maintenance", title: "paid", brief: "", repoId: r.id, autonomy: "observe" });
  const free = store.createTask({ kind: "maintenance", title: "free", brief: "", repoId: r.id, autonomy: "observe" });
  const now = new Date().toISOString();
  store.updateTask(paid.id, { status: "failed", costUsd: 2.5, startedAt: now, finishedAt: now });
  store.db.exec("DROP TABLE runs"); // what a database from before this change looks like
  store.close();

  store = new Store(file);
  assert.deepEqual(
    store.listRuns(paid.id).map((x) => [x.outcome, x.costUsd]),
    [["failed", 2.5]],
  );
  assert.equal(store.listRuns(free.id).length, 0);
  assert.equal(store.getTask(paid.id)?.costUsd, 2.5, "the task's total doesn't double");
  assert.equal(store.overview({ running: false, paused: false, driver: "x", factoryOutdated: false, uiOutdated: false, uiBuild: null, uiCommit: null }).spendThisWeekUsd, 2.5);
  store.close();
});

test("analytics: buckets spend by local day and compares with the span before", () => {
  const store = tmpStore();
  const api = store.addRepo({ path: "/code/api", name: "api" });
  const web = store.addRepo({ path: "/code/web", name: "web" });
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const daysAgo = (d: number) => {
    const x = new Date(noon);
    x.setDate(x.getDate() - d);
    return x.toISOString();
  };
  const spend = (repoId: string, status: "merged" | "rejected" | "needs_review", runs: [number, number][]) => {
    const t = store.createTask({ kind: "maintenance", title: `${status} in ${repoId}`, brief: "", repoId, autonomy: "propose" });
    store.updateTask(t.id, { status });
    for (const [ago, usd] of runs) {
      const id = store.startRun({ taskId: t.id, kind: "work", agentId: null, driver: "test" });
      store.finishRun(id, "succeeded", usage(usd));
      store.db.prepare("UPDATE runs SET finished_at = ? WHERE id = ?").run(daysAgo(ago), id);
    }
    return t;
  };
  const big = spend(api.id, "merged", [[0, 3], [1, 1]]);
  spend(web.id, "rejected", [[2, 0.5]]);
  spend(web.id, "needs_review", [[6, 0.25], [9, 4]]); // the second run is in the week before

  const a = store.analytics(7, noon.getTime());
  assert.equal(a.days, 7);
  assert.equal(a.daily.length, 7);
  assert.deepEqual(
    a.daily.map((d) => d.usd),
    [0.25, 0, 0, 0, 0.5, 1, 3],
  );
  assert.equal(a.spendUsd, 4.75);
  assert.equal(a.prevSpendUsd, 4);
  assert.equal(a.runs, 4);
  assert.equal(a.tasks, 3);
  assert.deepEqual(a.shipped, { usd: 4, tasks: 1 });
  assert.deepEqual(a.unshipped, { usd: 0.5, tasks: 1 });
  assert.deepEqual(
    a.byRepo.map((x) => [x.name, x.usd, x.tasks]),
    [
      ["api", 4, 1],
      ["web", 0.75, 2],
    ],
  );
  assert.deepEqual(a.byKind, [{ kind: "maintenance", usd: 4.75, tasks: 3 }]);
  assert.equal(a.topTasks[0]?.id, big.id);
  assert.equal(a.topTasks[0]?.runs, 2);
  assert.equal(a.tokens.cacheRead, 1200);

  // Today only.
  assert.equal(store.analytics(1, noon.getTime()).spendUsd, 3);
  store.close();
});

test("analytics: attributes spend to each run's agent, including Codex estimates", () => {
  const store = tmpStore();
  assert.deepEqual(store.analytics().byAgent, []);
  const t = store.createTask({ kind: "maintenance", title: "Switch agents", brief: "", repoId: null, autonomy: "observe", driver: "codex" });
  const finish = (driver: string, cost: number, kind: "work" | "resolve_conflicts" = "work") => {
    const id = store.startRun({ taskId: t.id, kind, agentId: null, driver });
    store.finishRun(id, "failed", usage(cost));
    return id;
  };
  finish("claude-code", 2);
  finish("claude-code", 0.5, "resolve_conflicts");
  const codexRun = store.startRun({ taskId: t.id, kind: "work", agentId: null, driver: "codex" });
  store.finishRun(codexRun, "succeeded", usageFromTurn({ input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 }, "gpt-5.3-codex"));
  finish("unknown", 0.25);
  const old = finish("claude-code", 8);
  store.db.prepare("UPDATE runs SET finished_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86400000).toISOString(), old);
  store.startRun({ taskId: t.id, kind: "work", agentId: null, driver: "running-only" });
  const a = store.analytics();
  assert.deepEqual(a.byAgent, [
    { driver: "claude-code", usd: 2.5, tasks: 1 },
    { driver: "codex", usd: 1.75, tasks: 1 },
    { driver: "unknown", usd: 0.25, tasks: 1 },
  ]);
  assert.equal(a.byAgent.reduce((sum, row) => sum + row.usd, 0), a.spendUsd);
  assert.equal(a.tasks, 1);
  store.close();
});

/** Reports what it spent, then fails, like a Claude Code run that hit its turn limit. */
class CostlyFailure implements AgentDriver {
  readonly name = "costly";
  readonly label = "Costly";
  async available() {
    return true;
  }
  async run(ctx: RunContext): Promise<RunResult> {
    ctx.onUsage?.(usage(0.8));
    throw new Error("Agent stopped: error_max_turns");
  }
}

test("factory: a run that fails still records what it cost", async () => {
  const store = tmpStore();
  const r = store.addRepo({ path: mkdtempSync(join(tmpdir(), "crane-cost-repo-")) });
  const t = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: r.id, autonomy: "observe" });
  const factory = new Factory(store, new CostlyFailure(), { crewSize: 1, tickMs: 20 });
  factory.start();
  for (let i = 0; i < 100 && store.getTask(t.id)?.status !== "failed"; i++) await new Promise((res) => setTimeout(res, 20));
  await factory.stop();
  assert.equal(store.getTask(t.id)?.status, "failed");
  assert.equal(store.getTask(t.id)?.costUsd, 0.8);
  assert.deepEqual(
    store.listRuns(t.id).map((x) => [x.outcome, x.costUsd, x.agentId]),
    [["failed", 0.8, "a-jib"]],
  );
  store.close();
});
