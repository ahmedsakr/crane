import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followUpFor, type TaskDetail } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { driverEffortKey, driverModelKey } from "../src/factory/settings.js";

function setup(path = ":memory:") {
  const store = new Store(path);
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  const parent = actions.createTask({ kind: "maintenance", title: "Review", brief: "Read the code", repoId: repo.id,
    autonomy: "observe", driver: "claude-code" });
  store.updateTask(parent.id, { status: "needs_review", report: { summary: "A finding", changedFiles: [], findings: [
    { title: "Fix the cache", detail: "Include the locale in the key.", impact: "high", effort: "small" },
  ] } });
  return { store, actions, parent };
}

test("follow-up: agent, model and effort are scoped to the new task and survive reopening the store", () => {
  const file = join(mkdtempSync(join(tmpdir(), "crane-follow-up-")), "crane.db");
  const { store, actions, parent } = setup(file);
  store.setSetting(driverModelKey("codex"), "gpt-saved");
  store.setSetting(driverEffortKey("codex"), "medium");
  const before = store.getTask(parent.id);
  const next = actions.followUp(parent.id, 0, { driver: "codex", model: " gpt-task ", effort: "XHIGH" });
  assert.equal(next.status, "queued");
  assert.equal(next.autonomy, "propose");
  assert.equal(next.kind, parent.kind);
  assert.equal(next.repoId, parent.repoId);
  assert.equal(next.title, "Fix the cache");
  assert.match(next.brief, /Include the locale in the key/);
  assert.ok(next.brief.includes(parent.id));
  assert.equal(next.driver, "codex");
  assert.equal(next.model, "gpt-task");
  assert.equal(next.effort, "xhigh");
  assert.equal(store.getSetting(driverModelKey("codex")), "gpt-saved");
  assert.equal(store.getSetting(driverEffortKey("codex")), "medium");
  assert.deepEqual(store.getTask(parent.id), before);
  assert.ok(store.listEvents(parent.id).some(e => e.type === "operator" && e.data?.taskId === next.id));
  store.close();
  const reopened = new Store(file);
  try { assert.deepEqual(reopened.getTask(next.id), next); }
  finally { reopened.close(); }
});

test("follow-up: defaults inherit the parent agent; changing agents clears incompatible task overrides", () => {
  const { store, actions, parent } = setup();
  try {
    const inherited = actions.followUp(parent.id, 0);
    assert.equal(inherited.driver, "claude-code");
    assert.equal(inherited.model, null);
    assert.equal(inherited.effort, null);
    const tuned = actions.followUp(parent.id, 0, { model: "opus", effort: "max" });
    store.updateTask(tuned.id, { report: store.getTask(parent.id)!.report });
    const same = actions.followUp(tuned.id, 0);
    assert.equal(same.model, "opus");
    assert.equal(same.effort, "max");
    const changed = actions.followUp(tuned.id, 0, { driver: "codex" });
    assert.equal(changed.model, null);
    assert.equal(changed.effort, null);
    const cleared = actions.followUp(tuned.id, 0, { model: "default", effort: null });
    assert.equal(cleared.model, null);
    assert.equal(cleared.effort, null);
    const defaultAgent = actions.followUp(parent.id, 0, { driver: "default" });
    assert.equal(defaultAgent.driver, null);
    const retry = actions.retry(tuned.id);
    assert.equal(retry.model, "opus");
    assert.equal(retry.effort, "max");
    const switchedRetry = actions.retry(tuned.id, { driver: "codex" });
    assert.equal(switchedRetry.model, null);
    assert.equal(switchedRetry.effort, null);
  } finally { store.close(); }
});

test("follow-up API: accepts scheduling choices and preserves the old request shape", async () => {
  const { store, parent } = setup();
  try {
    const app = createApp(store);
    for (const opts of [{}, { driver: "codex", model: "gpt-task", effort: "high" }, { driver: null }]) {
      const response = await app.request(`/api/tasks/${parent.id}/follow-up`, {
        method: "POST", body: JSON.stringify({ finding: 0, ...opts }),
      });
      assert.equal(response.status, 201);
      const next = await response.json();
      assert.equal(next.driver, "driver" in opts ? opts.driver : parent.driver);
      assert.equal(next.model, "model" in opts ? opts.model : null);
      assert.equal(next.effort, "effort" in opts ? opts.effort : null);
    }
  } finally { store.close(); }
});

test("follow-up: the source task's page shows each finding's latest follow-up and its state", async () => {
  const { store, actions, parent } = setup();
  try {
    const app = createApp(store);
    const detail = async () => (await (await app.request(`/api/tasks/${parent.id}`)).json()) as TaskDetail;
    assert.deepEqual((await detail()).followUps, []);

    const first = actions.followUp(parent.id, 0);
    assert.equal(first.followUpOf, parent.id);
    assert.equal(first.followUpFinding, 0);
    assert.ok(store.listEvents(parent.id).some(e => e.data?.taskId === first.id && e.data?.finding === 0));
    assert.deepEqual((await detail()).followUps, [{ id: first.id, title: "Fix the cache", status: "queued", finding: 0 }]);

    // Its state follows the follow-up as it moves on.
    store.updateTask(first.id, { status: "failed" });
    const again = actions.followUp(parent.id, 0);
    store.updateTask(again.id, { status: "running" });
    const { followUps } = await detail();
    assert.deepEqual(followUps.map(f => [f.id, f.status]), [[first.id, "failed"], [again.id, "running"]]);
    assert.equal(followUpFor(followUps, 0)?.id, again.id, "the latest attempt wins");
    assert.equal(followUpFor(followUps, 1), undefined);

    const created = actions.createTask({ kind: "maintenance", title: "Other", brief: "", repoId: parent.repoId, autonomy: "propose" });
    assert.equal(created.followUpOf, null);
    assert.equal(created.followUpFinding, null);
  } finally { store.close(); }
});

test("follow-up: an older database links past follow-ups to their findings from history", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-follow-up-migrate-"));
  const file = join(dir, "crane.db");
  let store = new Store(file);
  try {
    const actions = new OperatorActions(store);
    const repo = store.addRepo({ path: "/repo" });
    const parent = actions.createTask({ kind: "maintenance", title: "Review", brief: "", repoId: repo.id, autonomy: "observe" });
    store.updateTask(parent.id, { status: "needs_review", report: { summary: "", changedFiles: [], findings: [
      { title: "Fix the cache", detail: "", impact: "high", effort: "small" },
      { title: "Name the flag", detail: "", impact: "low", effort: "small" },
    ] } });
    const second = actions.followUp(parent.id, 1);
    const renamed = actions.followUp(parent.id, 0);
    store.updateTask(renamed.id, { title: "Fix the cache key" });
    const unrelated = actions.createTask({ kind: "maintenance", title: "Name the flag", brief: "", repoId: repo.id, autonomy: "propose" });
    store.addEvent(parent.id, "operator", "Started follow-up with unreadable data");
    store.db.prepare("INSERT INTO events(task_id, ts, type, message, data) VALUES(?, ?, 'operator', 'Started follow-up t-x', '{')")
      .run(parent.id, new Date().toISOString());

    store.db.exec("DROP INDEX tasks_follow_up");
    store.db.exec("ALTER TABLE tasks DROP COLUMN follow_up_of");
    store.db.exec("ALTER TABLE tasks DROP COLUMN follow_up_finding");
    store.close();
    store = new Store(file);

    assert.deepEqual(store.followUps(parent.id), [
      { id: second.id, title: "Name the flag", status: "queued", finding: 1 },
      // Its title no longer matches a finding, so it's linked to the task without guessing which finding.
      { id: renamed.id, title: "Fix the cache key", status: "queued", finding: null },
    ]);
    assert.equal(store.getTask(unrelated.id)!.followUpOf, null, "a task never started from a finding isn't linked");
    assert.equal(store.getTask(parent.id)!.followUpOf, null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("follow-up API: invalid scheduling choices and findings leave tasks and history unchanged", async () => {
  const { store, parent } = setup();
  try {
    const app = createApp(store);
    const before = store.listTasks();
    const events = store.listEvents(parent.id);
    const invalid = [null, [], {}, { finding: "0" }, { finding: -1 }, { finding: 0.5 }, { finding: 9 },
      ...[{ driver: "unknown" }, { driver: 42 }, { model: 42 }, { effort: false },
        { model: "--flag" }, { model: "gpt task" }, { driver: "codex", effort: "max" },
        { driver: "simulated", model: "opus" }, { driver: null, effort: "high" },
      ].map(opts => ({ finding: 0, ...opts }))];
    for (const body of [...invalid.map(body => JSON.stringify(body)), "{"]) {
      const response = await app.request(`/api/tasks/${parent.id}/follow-up`, { method: "POST", body });
      assert.equal(response.status, 400, body);
      assert.deepEqual(store.listTasks(), before, body);
      assert.deepEqual(store.listEvents(parent.id), events, body);
    }
  } finally { store.close(); }
});
