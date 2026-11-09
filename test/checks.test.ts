import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "@crane/storage";
import { parseReport } from "@crane/agent-protocol";

test("checks: operator configuration overrides factory defaults and remains distinct from unconfigured", () => {
  const store = new Store(":memory:");
  try {
    const factory = store.addRepo({ path: "/factory", isFactory: true });
    const other = store.addRepo({ path: "/other" });
    assert.deepEqual(store.repoChecks(factory.id), ["npm run typecheck", "npm test"]);
    assert.deepEqual(store.repoChecks(other.id), []);
    store.setRepoChecks(other.id, ["npm test"]);
    assert.deepEqual(store.repoChecks(other.id), ["npm test"]);
    store.setRepoChecks(factory.id, []);
    assert.deepEqual(store.repoChecks(factory.id), []);
  } finally { store.close(); }
});

test("checks: agents cannot supply factory validation evidence", () => {
  const report = parseReport('```crane-report\n{"summary":"done","validation":[{"status":"passed"}]}\n```');
  assert.equal(report.validation, undefined);
});
