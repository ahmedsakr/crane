import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftMission } from "../src/factory/instruct.js";
import { parseReport } from "../src/agents/report.js";
import { Store } from "../src/core/store.js";
import type { Repo } from "../src/core/types.js";

const repo = (name: string, isFactory = false): Repo => ({
  id: `r-${name}`,
  name,
  path: `/code/${name}`,
  defaultBranch: "main",
  isFactory,
  addedAt: new Date().toISOString(),
});
const repos = [repo("crane", true), repo("payments-api"), repo("storefront")];

test("draft: research wording stays read-only", () => {
  const d = draftMission("Investigate why the checkout tests are flaky in payments-api", repos);
  assert.equal(d.kind, "maintenance");
  assert.equal(d.repoId, "r-payments-api");
  assert.equal(d.autonomy, "observe");
});

test("draft: a requested change waits for review", () => {
  const d = draftMission("Add saved carts to storefront", repos);
  assert.equal(d.kind, "repo_feature");
  assert.equal(d.repoId, "r-storefront");
  assert.equal(d.autonomy, "propose");
});

test("draft: mentioning Crane targets the factory", () => {
  const d = draftMission("Research what crane should build next", repos);
  assert.equal(d.kind, "factory_feature");
  assert.equal(d.repoId, "r-crane");
});

test("draft: Crane's own vocabulary targets Crane even with one other repo connected", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  for (const text of [
    `I'd like to change the "missions" concept to be more "tasks" oriented`,
    `I'd like to rework the "Missions" concept to be more "Tasks" narrative`,
  ]) {
    const d = draftMission(text, two);
    assert.equal(d.repoId, "r-crane", text);
    assert.equal(d.kind, "factory_feature");
  }
});

test("draft: with no signal, Crane is still a candidate, so it asks", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  assert.equal(draftMission("Clean up the logging", two).repoId, null);
});

test("draft: falls back to the repo used last", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  assert.equal(draftMission("Clean up the logging", two, { lastRepoId: "r-crane" }).repoId, "r-crane");
  // An explicit mention still wins over memory.
  assert.equal(
    draftMission("Clean up the logging in wedding-guest-service", two, { lastRepoId: "r-crane" }).repoId,
    "r-wedding-guest-service",
  );
});

test("draft: ambiguous repo is left for the operator", () => {
  const d = draftMission("Fix the flaky tests", repos);
  assert.equal(d.repoId, null);
});

test("report: parses the fenced block", () => {
  const text = 'Done.\n\n```crane-report\n{"summary":"All good.","findings":[{"title":"A","detail":"B","impact":"high","effort":"tiny"}],"changedFiles":["x.ts"]}\n```';
  const r = parseReport(text);
  assert.equal(r.summary, "All good.");
  assert.equal(r.findings[0]!.impact, "high");
  assert.equal(r.findings[0]!.effort, "medium"); // unknown values fall back
  assert.deepEqual(r.changedFiles, ["x.ts"]);
});

test("report: falls back to the first paragraph", () => {
  const r = parseReport("The cache key ignores the locale.\n\nMore detail here.");
  assert.equal(r.summary, "The cache key ignores the locale.");
  assert.equal(r.findings.length, 0);
});

test("store: missions are claimed once, oldest first", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "crane-")), "t.db"));
  const r = store.addRepo({ path: "/code/x" });
  const a = store.createMission({ kind: "maintenance", title: "first", brief: "", repoId: r.id, autonomy: "observe" });
  store.createMission({ kind: "maintenance", title: "second", brief: "", repoId: r.id, autonomy: "observe" });
  assert.equal(store.claimNextMission("a-1")?.id, a.id);
  assert.equal(store.claimNextMission("a-2")?.title, "second");
  assert.equal(store.claimNextMission("a-3"), null);
  assert.equal(store.getMission(a.id)?.status, "running");
  store.close();
});
