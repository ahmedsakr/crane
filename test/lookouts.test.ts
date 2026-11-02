import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOKOUTS, lookoutsLabel, type Autonomy, type NewTask } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions, checkLookouts } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { resumePrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-lookouts-home-"));

function setup() {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  const make = (extra: Partial<NewTask> = {}, autonomy: Autonomy = "propose") =>
    actions.createTask({ kind: "maintenance", title: "Task", brief: "Do it", repoId: repo.id, autonomy, ...extra });
  return { store, actions, repo, make };
}

test("lookouts: checked by name, in Crane's order, without repeats", () => {
  assert.deepEqual(checkLookouts(undefined), []);
  assert.deepEqual(checkLookouts(null), []);
  assert.deepEqual(checkLookouts(["test-gaps", " Refactoring ", "refactoring", ""]), ["refactoring", "test_gaps"]);
  assert.deepEqual(checkLookouts([...LOOKOUTS].reverse()), [...LOOKOUTS]);
  assert.throws(() => checkLookouts(["security"]), /can't look out for “security”/);
  assert.throws(() => checkLookouts("refactoring"), /list of names/);
  assert.throws(() => checkLookouts([1]), /list of names/);
  assert.equal(lookoutsLabel([]), null);
  assert.equal(lookoutsLabel(["refactoring", "test_gaps"]), "Refactoring, test gaps");
});

test("lookouts: saved on the task, none by default, and kept by a retry", () => {
  const { store, actions, make } = setup();
  try {
    assert.deepEqual(make().lookouts, []);
    const t = make({ lookouts: ["test_gaps", "improvements"] });
    assert.deepEqual(t.lookouts, ["improvements", "test_gaps"]);
    assert.deepEqual(store.getTask(t.id)!.lookouts, ["improvements", "test_gaps"]);
    assert.deepEqual(actions.retry(t.id).lookouts, ["improvements", "test_gaps"]);
    assert.throws(() => make({ lookouts: ["nope" as never] }), /can't look out for/);
  } finally { store.close(); }
});

test("lookouts: the agent is told to report them as findings without widening the task", () => {
  const { store, make } = setup();
  try {
    assert.doesNotMatch(userPrompt(make()), /Also look for/, "no section when none are asked for");

    const change = userPrompt(make({ lookouts: ["refactoring", "test_gaps"] }));
    assert.match(change, /## Also look for/);
    assert.match(change, /^- Refactoring: /m);
    assert.match(change, /^- Test coverage gaps: /m);
    assert.doesNotMatch(change, /^- Improvements: /m, "only the ones asked for");
    assert.match(change, /These don't widen the task/);
    assert.match(change, /as a finding/);
    assert.match(change, /small, low-risk, and in code your change already touches/);

    const investigate = userPrompt(make({ lookouts: ["improvements"] }, "observe"));
    assert.match(investigate, /^- Improvements: /m);
    assert.doesNotMatch(investigate, /Fix one inside this task/, "investigate-only runs never change files");

    // A resumed session already has the brief, so it isn't repeated.
    assert.doesNotMatch(resumePrompt(), /Also look for/);
  } finally { store.close(); }
});

test("lookouts: follow-ups and the API take them, and reject unknown ones", async () => {
  const { store, actions, make } = setup();
  try {
    const review = make({ lookouts: ["refactoring"] }, "observe");
    store.updateTask(review.id, { report: { summary: "", changedFiles: [], findings: [
      { title: "Split the retry module", detail: "It does three things.", impact: "medium", effort: "small" },
    ] } });
    assert.deepEqual(actions.followUp(review.id, 0).lookouts, [], "a follow-up asks for its own");
    assert.deepEqual(actions.followUp(review.id, 0, { lookouts: ["test_gaps"] }).lookouts, ["test_gaps"]);

    const app = createApp(store);
    const post = (path: string, body: unknown) => app.request(`/api${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const created = await post(`/tasks/${review.id}/follow-up`, { finding: 0, lookouts: ["improvements"] });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).lookouts, ["improvements"]);

    const fresh = await post("/tasks", {
      kind: "maintenance", title: "New", brief: "Do it", repoId: review.repoId, autonomy: "propose", lookouts: ["test_gaps", "refactoring"],
    });
    assert.equal(fresh.status, 201);
    const task = await fresh.json();
    assert.deepEqual(task.lookouts, ["refactoring", "test_gaps"]);
    const detail = await (await app.request(`/api/tasks/${task.id}`)).json();
    assert.deepEqual(detail.task.lookouts, ["refactoring", "test_gaps"]);

    const bad = await post("/tasks", {
      kind: "maintenance", title: "Bad", brief: "Do it", repoId: review.repoId, autonomy: "propose", lookouts: ["everything"],
    });
    assert.equal(bad.status, 400);
  } finally { store.close(); }
});

test("lookouts: an older database gains the column, and unknown names are dropped on read", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-lookouts-migrate-"));
  const file = join(dir, "crane.db");
  let store = new Store(file);
  try {
    const task = store.createTask({ kind: "maintenance", title: "Existing", brief: "", repoId: null, autonomy: "observe" });
    store.db.exec("ALTER TABLE tasks DROP COLUMN lookouts");
    store.close();
    store = new Store(file);
    assert.deepEqual(store.getTask(task.id), task);

    store.db.prepare("UPDATE tasks SET lookouts = ? WHERE id = ?").run(JSON.stringify(["test_gaps", "from_a_newer_crane"]), task.id);
    assert.deepEqual(store.getTask(task.id)!.lookouts, ["test_gaps"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
