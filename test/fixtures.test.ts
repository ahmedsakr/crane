import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Store } from "@crane/storage";
import { join } from "node:path";
import { onFixtureCleanup, temporaryRoot } from "./support/fixtures.js";

test("fixture teardown survives setup failures and closes stores before removing roots", async () => {
  let teardown: () => Promise<void> = async () => { throw new Error("No teardown registered"); };
  const context = { after: (fn: () => Promise<void>) => { teardown = fn; } } as TestContext;
  let root = "";
  let store: Store | undefined;
  const order: string[] = [];
  assert.throws(() => {
    root = temporaryRoot(context, "crane-fixtures-");
    store = new Store(join(root, "test.db"));
    onFixtureCleanup(context, () => { assert.ok(existsSync(root)); store!.close(); order.push("closed"); });
    onFixtureCleanup(context, () => { order.push("stopped"); });
    throw new Error("setup failed");
  }, /setup failed/);
  await teardown();
  assert.deepEqual(order, ["stopped", "closed"]);
  assert.equal(existsSync(root), false);
});

test("fixture cleanup attempts remaining teardown after a failure and runs callbacks only once", async () => {
  let teardown: () => Promise<void> = async () => {};
  const context = { after: (fn: () => Promise<void>) => { teardown = fn; } } as TestContext;
  const root = temporaryRoot(context, "crane-fixtures-");
  let calls = 0;
  const stop = onFixtureCleanup(context, () => { calls++; });
  onFixtureCleanup(context, () => { throw new Error("cleanup failed"); });
  await stop();
  await assert.rejects(teardown(), /Fixture teardown failed/);
  assert.equal(calls, 1);
  assert.equal(existsSync(root), false);
});
