import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { AgentRunError } from "@crane/agent-protocol";
import type { ReviewCheckpoint, TaskStatus } from "@crane/contracts";
import { Store } from "@crane/storage";
import { PreparationHold } from "../src/factory/git.js";
import { classifyWorkFailure, handleWorkFailure, settleWorkRun, type WorkRun, type WorkRunDeps, type WorkRunSignals } from "../src/factory/work-run.js";
import { onFixtureCleanup } from "./support/fixtures.ts";

const QUIET: WorkRunSignals = { timeLimitHit: false, stopping: false, aborted: false };
const ALL: WorkRunSignals = { timeLimitHit: true, stopping: true, aborted: true };

const hold = () => new PreparationHold("A prerequisite is missing");
const outOfTurns = () => new AgentRunError("Ran out of turns", { limit: "turns" });

/** A task in the store, with a run's dependencies that record what they're asked to do. */
function harness(t: TestContext) {
  const store = new Store(":memory:");
  onFixtureCleanup(t, () => store.close());
  const repo = store.addRepo({ path: process.cwd(), name: "crane", isFactory: false });
  const task = store.createTask({ kind: "maintenance", title: "Fix it", brief: "", repoId: repo.id, autonomy: "propose" });
  const logs: string[] = [];
  const requeued: string[] = [];
  const ended: (TaskStatus | undefined)[] = [];
  const deps: WorkRunDeps = {
    store,
    drivers: new Map(),
    agentRunner: { store, maxTurns: 0, retryDelayMs: 0 },
    timeLimitMin: 90,
    log: (line) => logs.push(line),
    recording: (write) => write(),
    requeueStopped: (taskId) => requeued.push(taskId),
    taskEnded: (status) => ended.push(status),
  };
  const run: WorkRun = {
    agent: { id: "a-jib", name: "Jib" },
    task,
    signal: new AbortController().signal,
    emit: (type, message, data) => store.addEvent(task.id, type, message, data ?? null),
  };
  return { store, task, deps, run, logs, requeued, ended };
}

test("classifyWorkFailure: each branch outranks every branch after it", () => {
  // A single error can't be both a hold and a turn limit, so the first four run against each of them.
  for (const error of [hold(), outOfTurns()]) {
    assert.equal(classifyWorkFailure("cancelled", error, ALL), "cancelled");
    assert.equal(classifyWorkFailure("running", error, ALL), "time_limit");
    assert.equal(classifyWorkFailure("running", error, { ...ALL, timeLimitHit: false }), "factory_stopping");
    assert.equal(classifyWorkFailure("running", error, { ...QUIET, aborted: true }), "aborted");
  }
  assert.equal(classifyWorkFailure("running", hold(), QUIET), "preparation_hold");
  assert.equal(classifyWorkFailure("running", outOfTurns(), QUIET), "turn_limit");
  assert.equal(classifyWorkFailure("running", new Error("Something broke"), QUIET), "other");
});

test("classifyWorkFailure: a run that's only aborted is a cancellation, whatever the error", () => {
  assert.equal(classifyWorkFailure("running", new Error("Cancelled"), { ...QUIET, aborted: true }), "aborted");
  assert.equal(classifyWorkFailure(undefined, "not an error", { ...QUIET, aborted: true }), "aborted");
});

test("classifyWorkFailure: only a turn limit counts as one", () => {
  assert.equal(classifyWorkFailure("running", new AgentRunError("Overloaded", { transient: true }), QUIET), "other");
  assert.equal(classifyWorkFailure("running", { opts: { limit: "turns" } }, QUIET), "other");
  assert.equal(classifyWorkFailure(undefined, "not an error", QUIET), "other");
});

/** What each classification records: its new status, its events and its log line, word for word. */
const FAILURES: {
  name: string;
  from?: TaskStatus;
  error: unknown;
  signals: WorkRunSignals;
  status: TaskStatus;
  events: [string, string, Record<string, unknown> | null][];
  log?: string;
  requeued?: boolean;
}[] = [
  { name: "cancelled by the operator", from: "cancelled", error: new Error("Killed"), signals: ALL, status: "cancelled", events: [] },
  {
    name: "time limit",
    error: new Error("Killed"),
    signals: ALL,
    status: "failed",
    events: [
      ["error", "Stopped after 90 minutes, the most a task may run. Raise it with crane serve --time-limit or CRANE_TIME_LIMIT_MIN", { limit: "time" }],
      ["status", "Hit the time limit", { status: "failed" }],
    ],
    log: "Jib stopped $id at the time limit",
  },
  { name: "factory stopping", error: new Error("Killed"), signals: { ...ALL, timeLimitHit: false }, status: "running", events: [], requeued: true },
  {
    name: "aborted",
    error: new Error("Killed"),
    signals: { ...QUIET, aborted: true },
    status: "cancelled",
    events: [["status", "Cancelled", { status: "cancelled" }]],
  },
  {
    name: "preparation hold",
    error: hold(),
    signals: QUIET,
    status: "failed",
    events: [
      ["error", "A prerequisite is missing", { hold: true }],
      ["status", "Held before the agent started", { status: "failed" }],
    ],
    log: "Jib held $id: A prerequisite is missing",
  },
  {
    name: "turn limit",
    error: outOfTurns(),
    signals: QUIET,
    status: "failed",
    events: [
      ["error", "Ran out of turns", { limit: "turns" }],
      ["status", "Hit the turn limit", { status: "failed" }],
    ],
    log: "Jib failed $id: Ran out of turns",
  },
  {
    name: "anything else",
    error: new Error("Something broke"),
    signals: QUIET,
    status: "failed",
    events: [
      ["error", "Something broke", null],
      ["status", "Failed", { status: "failed" }],
    ],
    log: "Jib failed $id: Something broke",
  },
];

for (const failure of FAILURES) {
  test(`handleWorkFailure: ${failure.name}`, (t) => {
    const { store, task, deps, run, logs, requeued } = harness(t);
    store.updateTask(task.id, { status: failure.from ?? "running" });
    const before = store.listEvents(task.id).length;

    handleWorkFailure(deps, run, failure.error, failure.signals);

    assert.equal(store.getTask(task.id)!.status, failure.status);
    const events = store.listEvents(task.id).slice(before).map((e) => [e.type, e.message, e.data]);
    assert.deepEqual(events, failure.events);
    assert.deepEqual(logs, failure.log ? [failure.log.replace("$id", task.id)] : []);
    assert.deepEqual(requeued, failure.requeued ? [task.id] : []);
  });
}

const CHECKPOINT: ReviewCheckpoint = { commit: "abc", tree: "def", checks: [], dependencies: null, environment: "env", passed: [] };

test("settleWorkRun: a task going back in the queue keeps its checkpoint", (t) => {
  for (const status of ["queued", "running"] as const) {
    const { store, task, deps, ended } = harness(t);
    store.updateTask(task.id, { status, reviewCheckpoint: CHECKPOINT });
    settleWorkRun(deps, task.id);
    assert.deepEqual(store.getTask(task.id)!.reviewCheckpoint, CHECKPOINT, status);
    assert.deepEqual(ended, [status]);
  }
});

test("settleWorkRun: a task leaving queued or running loses its checkpoint", (t) => {
  for (const status of ["needs_review", "done", "merging", "failed", "cancelled"] as const) {
    const { store, task, deps, ended } = harness(t);
    store.updateTask(task.id, { status, reviewCheckpoint: CHECKPOINT });
    settleWorkRun(deps, task.id);
    assert.equal(store.getTask(task.id)!.reviewCheckpoint, null, status);
    assert.deepEqual(ended, [status]);
  }
});

test("settleWorkRun: a task that's gone still ends the run", (t) => {
  const { deps, ended } = harness(t);
  settleWorkRun(deps, "t-missing");
  assert.deepEqual(ended, [undefined]);
});
