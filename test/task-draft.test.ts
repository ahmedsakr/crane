import { test } from "node:test";
import assert from "node:assert/strict";
import type { Repo } from "@crane/contracts";
import { draftTask } from "@crane/factory/instruct";

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
  const d = draftTask("Investigate why the checkout tests are flaky in payments-api", repos);
  assert.equal(d.kind, "maintenance");
  assert.equal(d.repoId, "r-payments-api");
  assert.equal(d.autonomy, "observe");
});

test("draft: a requested change waits for review", () => {
  const d = draftTask("Add saved carts to storefront", repos);
  assert.equal(d.kind, "repo_feature");
  assert.equal(d.repoId, "r-storefront");
  assert.equal(d.autonomy, "propose");
});

test("draft: mentioning Crane targets the factory", () => {
  const d = draftTask("Research what crane should build next", repos);
  assert.equal(d.kind, "factory_feature");
  assert.equal(d.repoId, "r-crane");
});

test("draft: Crane's own vocabulary targets Crane even with one other repo connected", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  for (const text of [
    `I'd like to change the "missions" concept to be more "tasks" oriented`,
    `I'd like to rework the "Missions" concept to be more "Tasks" narrative`,
  ]) {
    const d = draftTask(text, two);
    assert.equal(d.repoId, "r-crane", text);
    assert.equal(d.kind, "factory_feature");
  }
});

test("draft: with no signal, Crane is still a candidate, so it asks", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  assert.equal(draftTask("Clean up the logging", two).repoId, null);
});

test("draft: falls back to the repo used last", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  assert.equal(draftTask("Clean up the logging", two, { lastRepoId: "r-crane" }).repoId, "r-crane");
  // An explicit mention still wins over memory.
  assert.equal(
    draftTask("Clean up the logging in wedding-guest-service", two, { lastRepoId: "r-crane" }).repoId,
    "r-wedding-guest-service",
  );
});

test("draft: ambiguous repo is left for the operator", () => {
  const d = draftTask("Fix the flaky tests", repos);
  assert.equal(d.repoId, null);
});
