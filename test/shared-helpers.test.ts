import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunUsage } from "@crane/contracts";
import { addRunUsage, combinedCost } from "@crane/agent-protocol";
import { usageFromTurn } from "../packages/agent-drivers/src/codex.js";

const usage: RunUsage = {
  costUsd: 2, inputTokens: 3, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 11, turns: 1, model: "first",
};

test("addRunUsage preserves the first report and adds every incremental field without mutation", () => {
  assert.equal(addRunUsage(null, usage), usage);
  const next = { ...usage, costStatus: "estimated" as const, turns: 2, model: "latest" };
  const before = structuredClone([usage, next]);
  assert.deepEqual(addRunUsage(usage, next), {
    costUsd: 4, costStatus: "estimated", inputTokens: 6, outputTokens: 10,
    cacheReadTokens: 14, cacheWriteTokens: 22, turns: 3, model: "latest",
  });
  assert.equal(addRunUsage(usage, { ...next, model: null }).model, "first");
  assert.deepEqual([usage, next], before);
  for (const costStatus of [undefined, "reported", "estimated", "unknown"] as const) {
    const report = { ...next, costStatus };
    const result = addRunUsage(usage, report);
    assert.deepEqual({ costUsd: result.costUsd, costStatus: result.costStatus }, combinedCost(usage, report));
  }
});

function formerCodexUsage(prev: RunUsage | null, next: RunUsage, turns: number): RunUsage {
  if (!prev) return next;
  return {
    ...prev, ...combinedCost(prev, next), inputTokens: prev.inputTokens + next.inputTokens,
    outputTokens: prev.outputTokens + next.outputTokens, cacheReadTokens: prev.cacheReadTokens + next.cacheReadTokens,
    turns,
  };
}

test("addRunUsage matches the former Codex accumulator across priced, unknown and zero turns", () => {
  const tokens = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 };
  for (const model of ["gpt-6.1-sol", "unpriced", null]) {
    let actual: RunUsage | null = null;
    let former: RunUsage | null = null;
    let turns = 0;
    for (const data of [tokens, undefined, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, tokens]) {
      const next = usageFromTurn(data, model);
      turns++;
      actual = addRunUsage(actual, next);
      former = formerCodexUsage(former, next, turns);
      assert.deepEqual(actual, former);
      assert.equal(actual.cacheWriteTokens, 0);
      assert.equal(actual.model, model);
      assert.equal(actual.turns, turns);
    }
  }
});
