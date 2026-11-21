import { test } from "node:test";
import assert from "node:assert/strict";
import { GUARD_REASONS } from "../packages/agent-policy/src/guard-rules.ts";
import { GUARD_ALWAYS_BLOCKS, GUARD_ASKS_FIRST } from "../web/src/lib/command-access.ts";

test("commands sheet: its lists cover every guard category, split by whether the operator can allow it", () => {
  assert.deepEqual([...Object.keys(GUARD_ALWAYS_BLOCKS), ...Object.keys(GUARD_ASKS_FIRST)].sort(), Object.keys(GUARD_REASONS).sort());
  for (const category of Object.keys(GUARD_ASKS_FIRST)) assert.match(GUARD_REASONS[category as keyof typeof GUARD_REASONS], /requires? an operator rule/);
});
