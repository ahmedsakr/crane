import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { Factory } from "../src/factory/orchestrator.js";
import { factoryIsRunning } from "../src/factory/state.js";
import { HEARTBEAT_KEY } from "../src/factory/settings.js";
import type { AgentDriver } from "@crane/agent-protocol";
import type { Task } from "@crane/contracts";

const driver: AgentDriver = {
  name: "simulated",
  label: "Simulated",
  async available() { return true; },
  async run() { throw new Error("Idle tests must not run an agent"); },
};
const NOW = Date.parse("2030-01-01T00:00:00Z");
// Keep these scheduler tests independent of worktrees, drivers, and subprocesses.
type Jobs = {
  sweepWorktrees(): void;
  work(agent: { id: string }, task: Task): Promise<void>;
  merge(agent: { id: string }, task: Task): Promise<void>;
};
const changes = (store: Store) => (store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

test("agent activity: only starting or ending work updates last active; repeated states do not write", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const store = new Store(":memory:");
  try {
    store.upsertAgent({ id: "a-one", name: "One", driver: driver.name });
    const agent = () => store.listAgents()[0]!;
    store.setAgentState("a-one", "idle", null);
    assert.equal(agent().lastActiveAt, null);
    store.setAgentState("a-one", "paused", null);
    assert.equal(agent().lastActiveAt, null);
    store.setAgentState("a-one", "working", "t-one");
    assert.equal(agent().lastActiveAt, new Date(NOW).toISOString());
    t.mock.timers.setTime(NOW + 1000);
    const before = changes(store);
    store.setAgentState("a-one", "working", "t-one");
    assert.equal(changes(store), before);
    assert.equal(agent().lastActiveAt, new Date(NOW).toISOString());
    store.setAgentState("a-one", "working", "t-two");
    assert.equal(agent().lastActiveAt, new Date(NOW + 1000).toISOString());
    t.mock.timers.setTime(NOW + 2000);
    store.setAgentState("a-one", "idle", null);
    assert.equal(agent().lastActiveAt, new Date(NOW + 2000).toISOString());
    t.mock.timers.setTime(NOW + 3000);
    store.setAgentState("a-one", "paused", null);
    store.setAgentState("a-one", "idle", null);
    assert.equal(agent().lastActiveAt, new Date(NOW + 2000).toISOString());
  } finally { store.close(); }
});

test("idle factory: eight slots write only the heartbeat every three seconds and never enter claims", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  const store = new Store(":memory:");
  const factory = new Factory(store, driver, { crewSize: 6 });
  t.mock.method(factory as unknown as Jobs, "sweepWorktrees", () => {});
  factory.start();
  const states = t.mock.method(store, "setAgentState");
  const pending = t.mock.method(store, "pendingWork");
  const transactions = t.mock.method(store.db, "transaction");
  const before = changes(store);
  try {
    for (let second = 1; second <= 9; second++) {
      t.mock.timers.tick(1000);
      assert.equal(changes(store) - before, Math.floor(second / 3), "only heartbeat writes while idle");
      assert.equal(factoryIsRunning(store), true);
    }
    assert.equal(states.mock.callCount(), 0, "cached idle state includes on-call members");
    assert.equal(pending.mock.callCount(), 9, "one read-only queue check per tick");
    assert.equal(transactions.mock.callCount(), 0, "no empty write transactions");
    store.setPaused(true);
    t.mock.timers.tick(1000);
    assert.equal(states.mock.callCount(), 8);
    t.mock.timers.tick(1000);
    assert.equal(states.mock.callCount(), 8, "paused states are cached too");
    store.setPaused(false);
    t.mock.timers.tick(1000);
    assert.equal(states.mock.callCount(), 16);
    assert.ok(store.listAgents().every(a => a.lastActiveAt === null));
  } finally {
    await factory.stop();
    assert.equal(store.getSetting(HEARTBEAT_KEY), "0");
    store.close();
  }
});

test("idle factory: failed heartbeat and state writes retry on the next tick", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  const store = new Store(":memory:");
  const factory = new Factory(store, driver);
  t.mock.method(factory as unknown as Jobs, "sweepWorktrees", () => {});
  factory.start();
  try {
    const setSetting = store.setSetting.bind(store);
    let failBeat = true;
    t.mock.method(store, "setSetting", (key: string, value: string) => {
      if (key === HEARTBEAT_KEY && failBeat) { failBeat = false; throw new Error("database is locked"); }
      setSetting(key, value);
    });
    for (let second = 0; second < 3; second++) t.mock.timers.tick(1000);
    assert.equal(store.getSetting(HEARTBEAT_KEY), String(NOW));
    t.mock.timers.tick(1000);
    assert.equal(store.getSetting(HEARTBEAT_KEY), String(NOW + 4000));
    const setState = store.setAgentState.bind(store);
    let failState = true;
    t.mock.method(store, "setAgentState", (...args: Parameters<Store["setAgentState"]>) => {
      if (failState) { failState = false; throw new Error("database is locked"); }
      setState(...args);
    });
    store.setPaused(true);
    t.mock.timers.tick(1000);
    assert.ok(store.listAgents().every(a => a.state === "idle"));
    t.mock.timers.tick(1000);
    assert.ok(store.listAgents().every(a => a.state === "paused"));
  } finally { await factory.stop(); store.close(); }
});

test("pending work: read-only hints exclude future work and claimed merges", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const store = new Store(":memory:");
  try {
    const task = store.createTask({ kind: "maintenance", title: "Future", brief: "", repoId: null,
      autonomy: "observe", scheduledAt: new Date(NOW + 1000).toISOString() });
    assert.deepEqual(store.pendingWork(), { queued: false, merging: false });
    t.mock.timers.setTime(NOW + 1000);
    assert.deepEqual(store.pendingWork(), { queued: true, merging: false });
    store.updateTask(task.id, { status: "merging" });
    assert.deepEqual(store.pendingWork(), { queued: false, merging: true });
    store.claimNextMerge("a-one");
    assert.deepEqual(store.pendingWork(), { queued: false, merging: false });
  } finally { store.close(); }
});

test("idle factory: newly queued work is picked up next tick, with merges first", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  const store = new Store(":memory:");
  const factory = new Factory(store, driver, { crewSize: 1 });
  const jobs = factory as unknown as Jobs;
  t.mock.method(jobs, "sweepWorktrees", () => {});
  const work = t.mock.method(jobs, "work", async () => {});
  const merge = t.mock.method(jobs, "merge", async () => {});
  factory.start();
  try {
    const make = (title: string) => store.createTask({ kind: "maintenance", title, brief: "", repoId: null, autonomy: "observe" });
    const task = make("Work");
    const merging = make("Merge");
    store.updateTask(merging.id, { status: "merging" });
    t.mock.timers.tick(1000);
    assert.equal(merge.mock.calls[0]!.arguments[1]!.id, merging.id);
    assert.equal(work.mock.callCount(), 0);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    t.mock.timers.tick(1000);
    assert.equal(work.mock.calls[0]!.arguments[1]!.id, task.id);
    assert.equal(store.getTask(task.id)!.status, "running");
  } finally { await factory.stop(); store.close(); }
});
