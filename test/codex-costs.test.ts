import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageFromTurn } from "../packages/agent-drivers/src/codex.js";
import { combinedCost } from "@crane/agent-protocol";
import { Store } from "@crane/storage";

const tokens = { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 };

test("Codex prices uncached, cached and output tokens separately for each model", () => {
  for (const [model, expected] of [
    ["gpt-5.3-codex", 2.52], ["gpt-6-astra", 11.4],
    ["gpt-6.1-sol", 2.24], ["gpt-6.1-terra", 1.12], ["gpt-6-luna", 0.114],
  ] as const) {
    const u = usageFromTurn(tokens, model);
    assert.ok(Math.abs(u.costUsd - expected) < 1e-10, model);
    assert.equal(u.costStatus, "estimated");
    assert.equal(u.inputTokens, 600_000);
    assert.equal(u.cacheReadTokens, 400_000);
  }
});

test("Codex distinguishes missing prices and malformed usage from a priced zero", () => {
  for (const model of [null, "unknown", "gpt-6.1-sol-custom", "toString"]) {
    assert.equal(usageFromTurn(tokens, model).costStatus, "unknown");
  }
  for (const data of [undefined, {}, { ...tokens, input_tokens: -1 }, { ...tokens, output_tokens: Infinity },
    { ...tokens, cached_input_tokens: 2_000_000 }]) {
    assert.equal(usageFromTurn(data, "gpt-5.3-codex").costStatus, "unknown");
  }
  const zero = usageFromTurn({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, "gpt-5.3-codex");
  assert.equal(zero.costUsd, 0);
  assert.equal(zero.costStatus, "estimated");
});

test("Codex adds turn costs and preserves known amounts when another turn is unknown", () => {
  const u = usageFromTurn(tokens, "gpt-5.3-codex");
  assert.deepEqual(combinedCost(u, u), { costUsd: 5.04, costStatus: "estimated" });
  assert.deepEqual(combinedCost(u, usageFromTurn(tokens, null)), { costUsd: 2.52, costStatus: "unknown" });
});

test("run ledger persists estimates and flags unknown costs without treating real zeros as unknown", () => {
  const path = join(mkdtempSync(join(tmpdir(), "crane-codex-cost-")), "t.db");
  let store = new Store(path);
  const task = store.createTask({ kind: "maintenance", title: "Cost", brief: "", repoId: null, autonomy: "observe" });
  const finish = (u: ReturnType<typeof usageFromTurn> | null) => {
    const id = store.startRun({ taskId: task.id, kind: "work", agentId: null, driver: "codex" });
    store.finishRun(id, "succeeded", u);
    store.finishRun(id, "succeeded", u); // idempotent
  };
  finish(usageFromTurn(tokens, "gpt-5.3-codex"));
  finish(usageFromTurn(tokens, null));
  finish(usageFromTurn({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, "gpt-5.3-codex"));
  finish(null);
  store.close();
  store = new Store(path);
  assert.equal(store.getTask(task.id)?.costUsd, 2.52);
  assert.equal(store.analytics().spendUsd, 2.52);
  assert.equal(store.analytics().unknownCostRuns, 2);
  assert.deepEqual(store.listRuns(task.id).map((r) => r.costStatus), ["estimated", "unknown", "estimated", "unknown"]);
  // Simulate an older ledger: the migration must not reprice historical Codex zeros.
  store.db.exec("ALTER TABLE runs DROP COLUMN cost_status");
  store.close();
  store = new Store(path);
  assert.deepEqual(store.listRuns(task.id).map((r) => r.costStatus), ["reported", "unknown", "unknown", "unknown"]);
  assert.equal(store.analytics().unknownCostRuns, 3);
  store.close();
});
