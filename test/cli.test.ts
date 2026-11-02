import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { toRule } from "../src/factory/actions.js";
import { runCli } from "../src/cli/program.js";
import { ruleLabel } from "@crane/contracts";

/**
 * In-process smoke tests for the CLI. Each runs a real `crane` command against
 * an in-memory store and checks the same state changes the API tests do, so the
 * CLI and the dashboard stay at parity on operator actions.
 */

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function crane(store: Store, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const exit = process.exit;
  console.log = (...a: unknown[]) => void out.push(plain(a.join(" ")));
  console.error = (...a: unknown[]) => void err.push(plain(a.join(" ")));
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0);
  }) as typeof process.exit;
  let code = 0;
  try {
    await runCli(["node", "crane", ...args], store);
  } catch (e) {
    // A failing command's catch block can call `ui.fail` again with our Exit; the first exit wins.
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function setup() {
  const store = new Store(":memory:");
  const repo = store.addRepo({ path: "/repo", name: "app" });
  const task = (status: Parameters<Store["updateTask"]>[1]["status"], branch = true) => {
    const t = store.createTask({ kind: "maintenance", title: `${status} task`, brief: "", repoId: repo.id, autonomy: "propose" });
    store.updateTask(t.id, { status, branch: branch ? `crane/${t.id}` : null,
      visualReview: { status: "not_required", commit: "a".repeat(40), tree: "b".repeat(40), note: "No UI changes", decidedAt: null } });
    return store.getTask(t.id)!;
  };
  return { store, repo, task };
}

test("cli: visual decisions are separate from approval, candidate-bound and explicit", async () => {
  const { store, task } = setup();
  const candidate = task("needs_review");
  const commit = "a".repeat(40);
  store.updateTask(candidate.id, { visualReview: { status: "pending", commit, tree: "b".repeat(40), note: "UI changed", decidedAt: null } });
  try {
    assert.equal((await crane(store, "approve", candidate.id, "-m", "waive review")).code, 1);
    assert.equal((await crane(store, "visual-review", candidate.id, "--commit", "c".repeat(40), "--waive", "-m", "Urgent repair; task page at all sizes unreviewed")).code, 1);
    assert.equal((await crane(store, "visual-review", candidate.id, "--commit", commit, "--waive", "-m", "Urgent repair; task page at all sizes unreviewed")).code, 0);
    assert.equal(store.getTask(candidate.id)!.visualReview!.status, "waived");
    assert.equal(store.getTask(candidate.id)!.status, "needs_review");
    assert.equal((await crane(store, "approve", candidate.id)).code, 0);
    const inspected = task("needs_review");
    store.updateTask(inspected.id, { visualReview: { status: "pending", commit, tree: "b".repeat(40), note: "UI changed", decidedAt: null } });
    assert.equal((await crane(store, "visual-review", inspected.id, "--commit", commit, "-m", "Task page wide, short, phone; .crane/screenshots/task-*.png; no clipping")).code, 0);
    assert.equal(store.getTask(inspected.id)!.visualReview!.status, "inspected");
  } finally { store.close(); }
});

test("cli: recurring crew schedules add, list, update pre-approval, pause, resume and remove", async () => {
  const { store } = setup();
  store.upsertAgent({ id: "a-jib", name: "Jib", driver: "simulated" });
  store.setSetting("crew_role_a-jib", "tests");
  try {
    const added = await crane(store, "agents", "schedule", "add", "jib", "--repo", "app", "--days", "1,2,3,4,5", "--time", "09:00", "--timezone", "America/Toronto", "--pre-approve");
    assert.equal(added.code, 0, added.err);
    const s = store.listCrewSchedules()[0]!;
    assert.equal(s.daysMask, 62);
    assert.equal(s.preApprove, true);
    const list = await crane(store, "agents", "schedule", "list", "jib", "--json");
    assert.equal(list.code, 0, list.err);
    assert.equal(JSON.parse(list.out)[0].id, s.id);
    for (const [operation, enabled] of [["pause", false], ["resume", true]] as const) {
      const result = await crane(store, "agents", "schedule", operation, "jib", s.id);
      assert.equal(result.code, 0, result.err);
      assert.equal(store.listCrewSchedules()[0]!.enabled, enabled);
    }
    const update = await crane(store, "agents", "schedule", "update", "jib", s.id, "--no-pre-approve", "--time", "10:00");
    assert.equal(update.code, 0, update.err);
    assert.equal(store.listCrewSchedules()[0]!.preApprove, false);
    const unchanged = await crane(store, "agents", "schedule", "update", "jib", s.id, "--days", "1");
    assert.equal(unchanged.code, 0, unchanged.err);
    assert.equal(store.listCrewSchedules()[0]!.preApprove, false, "omitted flags preserve saved pre-approval");
    assert.equal(store.listCrewSchedules()[0]!.localTime, "10:00");
    assert.equal((await crane(store, "agents", "schedule", "remove", "jib", s.id)).code, 0);
    assert.equal(store.listCrewSchedules().length, 0);
    const invalid = await crane(store, "agents", "schedule", "add", "jib", "--repo", "app", "--days", "7", "--time", "09:00", "--timezone", "UTC");
    assert.equal(invalid.code, 1);
  } finally { store.close(); }
});

test("cli: approve merges by default, --no-merge approves only, and options don't leak between runs", async () => {
  const { store, task } = setup();
  try {
    const kept = task("needs_review");
    const r1 = await crane(store, "approve", kept.id, "--no-merge", "-m", "Reviewed");
    assert.equal(r1.code, 0, r1.err);
    assert.match(r1.out, /Approved .*branch crane\/.* is kept/);
    assert.equal(store.getTask(kept.id)!.status, "approved");
    assert.ok(store.listEvents(kept.id).some((e) => e.type === "operator" && e.message === "Approved: Reviewed"));

    // Same process, same commander program: --no-merge from the last run must not stick.
    const merged = task("needs_review");
    const r2 = await crane(store, "approve", merged.id);
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, /Approved\. Merging into main/);
    assert.equal(store.getTask(merged.id)!.status, "merging");
    assert.ok(!store.listEvents(merged.id).some((e) => e.message?.startsWith("Approved:")));
  } finally {
    store.close();
  }
});

test("cli: approve refuses a task that isn't waiting, leaving it and its history unchanged", async () => {
  const { store, task } = setup();
  try {
    for (const status of ["queued", "running", "approved", "merged", "cancelled"] as const) {
      const t = task(status);
      const events = store.listEvents(t.id);
      const r = await crane(store, "approve", t.id);
      assert.equal(r.code, 1, status);
      assert.match(r.err.split("\n")[0]!, /isn't waiting for review/, status);
      assert.deepEqual(store.getTask(t.id), t, status);
      assert.deepEqual(store.listEvents(t.id), events, status);
    }
    const missing = await crane(store, "approve", "t-missing");
    assert.equal(missing.code, 1);
  } finally {
    store.close();
  }
});

test("cli: cancel records the decision once and cannot cancel a finished task", async () => {
  const { store, task } = setup();
  try {
    for (const status of ["queued", "running"] as const) {
      const t = task(status, false);
      const r = await crane(store, "cancel", t.id);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`Cancelled ${t.id}`));
      const cancelled = store.getTask(t.id)!;
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.finishedAt);
      const events = store.listEvents(t.id);
      assert.equal(events.filter((e) => e.type === "operator" && e.message === "Cancelled by operator").length, 1);

      const again = await crane(store, "cancel", t.id);
      assert.equal(again.code, 1);
      assert.match(again.err.split("\n")[0]!, /isn't in progress/);
      assert.deepEqual(store.getTask(t.id), cancelled);
      assert.deepEqual(store.listEvents(t.id), events);
    }
  } finally {
    store.close();
  }
});

test("cli: allow saves the rule for the repo, notes it on the task, and refuses denied or unscoped rules", async () => {
  const { store, repo, task } = setup();
  try {
    const t = task("needs_review");
    const r = await crane(store, "allow", "npm ci", "-r", "app", "-t", t.id);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Allowed .* for app/);
    assert.deepEqual(store.repoTools(repo.id).allowed, [toRule("npm ci")]);
    assert.equal(store.listEvents(t.id).filter((e) => e.message === `Allowed ${ruleLabel(toRule("npm ci"))} for app`).length, 1);

    const before = store.repoTools(repo.id);
    for (const [args, error] of [
      [["git push", "-r", "app"], /never allowed/],
      [["Bash(*)", "-r", "app"], /every command/],
      [["npm test", "-r", "nope"], /No repo called nope/],
      // Not blocked anywhere yet, so the CLI can't guess the repo.
      [["npm test"], /Which repo\?/],
    ] as const) {
      const denied = await crane(store, "allow", ...args);
      assert.equal(denied.code, 1, args.join(" "));
      assert.match(denied.err.split("\n")[0]!, error, args.join(" "));
      assert.deepEqual(store.repoTools(repo.id), before, args.join(" "));
    }
  } finally {
    store.close();
  }
});

test("cli: tasks --json lists open tasks by default, with branch, worktree and repo name", async () => {
  const { store, task } = setup();
  try {
    const open = task("needs_review");
    store.updateTask(open.id, { worktree: "/worktrees/x" });
    const queued = task("queued", false);
    const done = task("merged");

    const parse = (out: string) => JSON.parse(out) as { id: string; status: string; branch: string | null; worktree: string | null; repo: string | null }[];
    const r = await crane(store, "tasks", "--json");
    assert.equal(r.code, 0, r.err);
    const list = parse(r.out);
    assert.deepEqual(new Set(list.map((m) => m.id)), new Set([open.id, queued.id]));
    const row = list.find((m) => m.id === open.id)!;
    assert.equal(row.branch, `crane/${open.id}`);
    assert.equal(row.worktree, "/worktrees/x");
    assert.equal(row.repo, "app");

    // --all from a previous run must not leak into this one; -s narrows.
    const all = parse((await crane(store, "tasks", "--all", "--json")).out);
    assert.ok(all.some((m) => m.id === done.id));
    assert.equal(parse((await crane(store, "tasks", "--json")).out).length, 2);
    assert.deepEqual(parse((await crane(store, "tasks", "-s", "merged", "--json")).out).map((m) => m.id), [done.id]);
    assert.equal(parse((await crane(store, "tasks", "-a", "-n", "1", "--json")).out).length, 1);

    const bad = await crane(store, "tasks", "-n", "0", "--json");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--limit takes a whole number/);
  } finally {
    store.close();
  }
});
