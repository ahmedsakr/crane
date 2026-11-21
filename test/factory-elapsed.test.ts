import { test } from "node:test";
import assert from "node:assert/strict";
import { elapsed } from "../packages/factory/src/elapsed.js";

test("dependencies: durations read naturally", () => {
  assert.equal(elapsed(420), "0.4s");
  assert.equal(elapsed(12_400), "12s");
  assert.equal(elapsed(161_000), "2m 41s");
});
