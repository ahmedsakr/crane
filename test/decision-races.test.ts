import "../src/application.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATUS_LABEL, type Task } from "@crane/contracts";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { onFixtureCleanup, temporaryRoot } from "./support/fixtures.js";
import { sh } from "./support/git.js";

/**
 * Several operators decide at once, through the dashboard or the CLI, which
 * are separate processes sharing one database. Of decisions racing on one
 * task, exactly one may win; the loser changes nothing and says why.
 */

const BRANCH = "crane/add-line-t1";

function open(t: TestContext, file: string) {
  const store = new Store(file);
  onFixtureCleanup(t, () => store.close());
  return store;
}

/** A repo whose task branch is checked out in a worktree, and a task on it waiting for review, in a database file. */
function setup(t: TestContext, status: Task["status"] = "needs_review") {
  const root = temporaryRoot(t, "crane-races-");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "notes.md"), "first\n");
  sh(checkout, "add", "notes.md");
  sh(checkout, "commit", "-q", "-m", "start");
  const worktree = join(root, "wt");
  sh(checkout, "worktree", "add", "-q", "-b", BRANCH, worktree);
  const file = join(root, "crane.db");
  const store = open(t, file);
  const repo = store.addRepo({ path: checkout });
  const created = store.createTask({ kind: "maintenance", title: "Add a line", brief: "", repoId: repo.id, autonomy: "propose" });
  // A backend-only candidate, so approval needs no visual decision.
  const visualReview = { status: "not_required" as const, commit: "a".repeat(40), tree: "b".repeat(40), note: "Backend only", decidedAt: null };
  store.updateTask(created.id, { status, branch: BRANCH, worktree, agentId: "a-one", visualReview });
  return { t, file, checkout, worktree, store, actions: new OperatorActions(store), task: store.getTask(created.id)! };
}

type Setup = ReturnType<typeof setup>;

/** Start every decision at once, in order, and collect each one's error, or null for the ones that succeeded. */
async function race(...decisions: (() => unknown)[]): Promise<(Error | null)[]> {
  return Promise.all(decisions.map(async (decide) => {
    try {
      await decide();
      return null;
    } catch (err) {
      return err as Error;
    }
  }));
}

/**
 * Have `other` act just before `store` opens its next transaction: another
 * operator deciding after this one read the task but before it claims it.
 * Returns what `other` returned, such as its decision's promise.
 */
function actsInBetween(store: Store, other: () => unknown): { done: () => Promise<unknown> } {
  const transaction = store.transaction.bind(store);
  let pending: unknown;
  store.transaction = ((fn, options) => {
    store.transaction = transaction;
    pending = other();
    return transaction(fn, options);
  }) as Store["transaction"];
  return { done: async () => pending };
}

const decisions = (s: Setup) => s.store.listEvents(s.task.id).filter((e) => e.type === "operator").map((e) => e.message);
const statusChanges = (s: Setup, status: string) =>
  s.store.listEvents(s.task.id).filter((e) => e.type === "status" && e.data?.status === status).length;

function branchExists(s: Setup) {
  try {
    sh(s.checkout, "rev-parse", "-q", "--verify", `refs/heads/${BRANCH}`);
    return true;
  } catch {
    return false;
  }
}

function oneWinner(errors: (Error | null)[]): Error {
  assert.equal(errors.filter((e) => e === null).length, 1, `exactly one decision wins: ${errors.map((e) => e?.message)}`);
  return errors.find((e) => e !== null)!;
}

/** A merging task still has what the merge needs; a declined one has given it up. */
function assertCoherent(s: Setup) {
  const task = s.store.getTask(s.task.id)!;
  if (task.status === "merging") {
    assert.equal(task.worktree, s.worktree);
    assert.equal(task.branch, BRANCH);
    assert.ok(existsSync(s.worktree), "a merging task keeps its worktree");
    assert.ok(branchExists(s), "and its branch");
    assert.equal(statusChanges(s, "merging"), 1, "it's queued to merge once");
  } else if (task.status === "rejected") {
    assert.equal(task.worktree, null);
    assert.equal(task.branch, null);
    assert.ok(!existsSync(s.worktree));
    assert.ok(!branchExists(s));
  } else {
    assert.equal(task.status, "approved");
    assert.equal(task.worktree, null);
    assert.ok(branchExists(s), "approve only keeps the branch");
  }
  assert.equal(statusChanges(s, task.status), 1, "the winner's status is recorded once");
  return task;
}

/** How a refusal names the status the winner left: "merging", "declined", "approved". */
const label = (task: Task) => STATUS_LABEL[task.status].toLowerCase();

const approve = (s: Setup) => () => s.actions.approve(s.task.id);
const approveOnly = (s: Setup) => () => s.actions.approve(s.task.id, undefined, { merge: false });
const decline = (s: Setup) => () => s.actions.reject(s.task.id);

test("decision races: approve and decline together, in either order, leave one decision", async (t) => {
  const cases = { "approve, decline": [approve, decline], "decline, approve": [decline, approve],
    "approve only, decline": [approveOnly, decline], "decline, approve only": [decline, approveOnly] };
  for (const [name, pair] of Object.entries(cases)) {
    const s = setup(t);
    const loser = oneWinner(await race(...pair.map((d) => d(s))));
    const task = assertCoherent(s);
    assert.match(loser.message, new RegExp(`^Task ${s.task.id} isn't waiting for review.* It's ${label(task)}$`), name);
    assert.equal(decisions(s).length, 1, `${name}: ${decisions(s)}`);
  }
});

test("decision races: two approves record one Approved event and one merge queue entry", async (t) => {
  for (const pair of [[approve, approve], [approveOnly, approve], [approve, approveOnly]]) {
    const s = setup(t);
    oneWinner(await race(...pair.map((d) => d(s))));
    const task = assertCoherent(s);
    assert.deepEqual(decisions(s), ["Approved"]);
    if (task.status === "merging") {
      assert.equal(s.store.claimNextMerge("a-jib")?.id, task.id);
      assert.equal(s.store.claimNextMerge("a-boom"), null, "only one merge to claim");
    }
  }
});

test("decision races: approve against cancel leaves one decision", async (t) => {
  const s = setup(t);
  const loser = oneWinner(await race(() => s.actions.cancel(s.task.id), approve(s)));
  assert.match(loser.message, /isn't in progress\. It's waiting for review$/);
  assert.equal(assertCoherent(s).status, "merging");
  assert.deepEqual(decisions(s), ["Approved"]);
});

test("decision races: a decline whose cleanup fails stays declined, with an error event", async (t) => {
  const s = setup(t);
  const updateTask = s.store.updateTask.bind(s.store);
  s.store.updateTask = (id, patch) => {
    if ("worktree" in patch) throw new Error("database or disk is full");
    updateTask(id, patch);
  };
  const task = await s.actions.reject(s.task.id);
  assert.equal(task.status, "rejected");
  assert.deepEqual(decisions(s), ["Declined"]);
  const error = s.store.listEvents(task.id).find((e) => e.type === "error");
  assert.match(error?.message ?? "", /Couldn't remove the worktree .*disk is full/);
});

test("decision races: a retry and its event commit together", (t) => {
  const s = setup(t, "failed");
  const addEvent = s.store.addEvent.bind(s.store);
  s.store.addEvent = (...args: Parameters<Store["addEvent"]>) => {
    if (args[2].startsWith("Retried as")) throw new Error("database or disk is full");
    return addEvent(...args);
  };
  const before = s.store.listTasks().length;
  assert.throws(() => s.actions.retry(s.task.id), /disk is full/);
  assert.equal(s.store.listTasks().length, before, "no retry without its record");
});

test("decision races: Store instances on one database file can't both claim a decision", async (t) => {
  const pairs: Record<string, [typeof approve, typeof approve]> = { "approve, then decline": [approve, decline], "decline, then approve": [decline, approve],
    "approve, then approve": [approve, approve], "approve only, then approve": [approveOnly, approve] };
  for (const [name, [first, second]] of Object.entries(pairs)) {
    const s = setup(t);
    // The CLI, as a second process, decides after the server read the task but before its claim.
    const cli = { ...s, store: open(t, s.file) };
    cli.actions = new OperatorActions(cli.store);
    const other = actsInBetween(s.store, second(cli));
    const [lost] = await race(first(s));
    await other.done();
    assert.ok(lost, `${name}: the server's stale decision loses`);
    const task = assertCoherent(s);
    assert.match(lost.message, new RegExp(`^Task ${s.task.id} isn't waiting for review any more\\. It's ${label(task)}$`), name);
    assert.equal(decisions(s).length, 1, `${name}: ${decisions(s)}`);
  }
});

test("decision races: a stale cancel loses to a run that finished and was approved meanwhile", async (t) => {
  const s = setup(t, "running");
  const cli = { ...s, store: open(t, s.file) };
  cli.actions = new OperatorActions(cli.store);
  const other = actsInBetween(s.store, () => {
    cli.store.finishWork(s.task.id, "needs_review");
    return cli.actions.approve(s.task.id);
  });
  assert.throws(() => s.actions.cancel(s.task.id), /Task \S+ isn't in progress any more\. It's merging$/);
  await other.done();
  assert.equal(assertCoherent(s).status, "merging");
  assert.deepEqual(decisions(s), ["Approved"]);
});

test("decision races: only one of two stores' transitions wins, and only its event is written", (t) => {
  const s = setup(t);
  const other = open(t, s.file);
  const change = { from: ["needs_review" as const], to: "rejected" as const, message: "Declined" };
  assert.equal(s.store.transitionStatus(s.task.id, change), true);
  assert.equal(other.transitionStatus(s.task.id, { ...change, to: "merging" }), false);
  assert.equal(other.getTask(s.task.id)!.status, "rejected");
  assert.equal(statusChanges(s, "rejected"), 1);
  assert.equal(statusChanges(s, "merging"), 0);
});
