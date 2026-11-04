import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("cli: follow-up takes acceptance checks, and show reports Crane's result on the candidate", async () => {
  const { store, repo } = setup();
  try {
    store.setRepoChecks(repo.id, ["npm test", "npm run typecheck"]);
    const source = store.createTask({ kind: "maintenance", title: "Source", brief: "", repoId: repo.id, autonomy: "observe" });
    store.updateTask(source.id, { report: { summary: "Found it", findings: [{ title: "Fix it", detail: "Details", impact: "low", effort: "small" }], changedFiles: [] } });

    const rejected = await crane(store, "follow-up", source.id, "1", "--accept-check", "npm run lint");
    assert.equal(rejected.code, 1);
    assert.match(rejected.err, /isn't one of this repo's checks/);

    assert.equal((await crane(store, "follow-up", source.id, "1", "--accept-check", "npm test", "--accept-check", "npm run typecheck")).code, 0);
    const task = store.followUps(source.id).at(-1)!;
    const commit = "a".repeat(40);
    store.updateTask(task.id, {
      visualReview: { status: "not_required", commit, tree: "b".repeat(40), note: "No UI changes", decidedAt: null },
      report: { summary: "Done", findings: [], changedFiles: [], validation: [{ phase: "review", commit, command: "npm test", status: "passed", exitCode: 0, logs: "", durationMs: 1 }] },
    });
    const shown = (await crane(store, "show", task.id)).out;
    assert.match(shown, /✓ {2}npm test {2}passed on aaaaaaa/);
    assert.match(shown, /○ {2}npm run typecheck {2}not run on this candidate/);
  } finally {
    store.close();
  }
});

test("cli: goals supports research, feedback, exact-version approval, progress and cancellation", async () => {
  const { store, repo } = setup();
  const dir = mkdtempSync(join(tmpdir(), "crane-goal-cli-"));
  try {
    const created = await crane(store, "goals", "create", "Customers can save carts", "--repo", repo.name, "--agent", "codex", "--effort", "high", "--json");
    assert.equal(created.code, 0, created.err);
    const first = JSON.parse(created.out).goal;
    assert.equal(first.status, "researching");
    const plan = { summary: "Save carts", approach: "Implement and verify saved carts in one isolated task", improvements: [], tasks: [
      { key: "carts", title: "Save carts", brief: "Implement and test saved carts", dependsOn: [], driver: "codex", model: null, effort: "high", rationale: "One coherent change", acceptance: ["Saved cart survives a reload"] },
    ] };
    const researchDone = (taskId: string) => store.updateTask(taskId, { status: "done", report: { summary: "Ready", findings: [], changedFiles: [], goalPlan: plan, completion: { status: "completed", reason: "Complete plan", evidence: "Read repo" } } });
    researchDone(first.researchTaskId);
    const shown = await crane(store, "goals", "show", first.id, "--json");
    const ready = JSON.parse(shown.out).goal;
    assert.equal(ready.status, "needs_review");
    const feedback = await crane(store, "goals", "feedback", first.id, "Add accessibility coverage", "--revision", String(ready.revision), "--json");
    assert.equal(feedback.code, 0, feedback.err);
    const revised = JSON.parse(feedback.out).goal;
    researchDone(revised.researchTaskId);
    store.syncGoals();
    const replanned = await crane(store, "goals", "change-agent", first.id, "carts", "--revision", String(store.getGoal(first.id)!.revision), "--agent", "claude-code", "--model", "sonnet", "--json");
    assert.equal(replanned.code, 0, replanned.err);
    assert.equal(JSON.parse(replanned.out).goal.plan.tasks[0].model, "sonnet");
    const planFile = join(dir, "plan.json");
    writeFileSync(planFile, JSON.stringify({ ...plan, summary: "Refined plan" }));
    const edited = await crane(store, "goals", "edit", first.id, "--revision", String(store.getGoal(first.id)!.revision), "--file", planFile, "--json");
    assert.equal(edited.code, 0, edited.err);
    assert.equal(JSON.parse(edited.out).goal.plan.summary, "Refined plan");
    const revision = store.getGoal(first.id)!.revision;
    const approved = await crane(store, "goals", "approve", first.id, "--revision", String(revision), "--auto-merge", "--json");
    assert.equal(approved.code, 0, approved.err);
    const active = JSON.parse(approved.out).goal;
    assert.equal(active.tasks.length, 1);
    assert.ok(store.getTask(active.tasks[0].taskId)!.preApprovedAt);
    assert.equal((await crane(store, "goals", "approve", first.id, "--revision", String(revision))).code, 1);
    assert.match((await crane(store, "show", active.tasks[0].taskId)).out, new RegExp(`crane goals show ${first.id}`));
    const listed = JSON.parse((await crane(store, "goals", "--json")).out);
    assert.equal(listed[0].id, first.id);
    const changed = await crane(store, "change-agent", active.tasks[0].taskId, "--agent", "codex", "--model", "gpt-5-codex", "--effort", "low");
    assert.equal(changed.code, 0, changed.err);
    assert.match((await crane(store, "goals", "show", first.id)).out, /Codex · gpt-5-codex · low effort/, "show gives the task's current agent, not the frozen plan's");
    store.setStatus(active.tasks[0].taskId, "failed");
    store.syncGoals();
    assert.equal((await crane(store, "change-agent", active.tasks[0].taskId, "--agent", "claude-code")).code, 1, "only a queued task's agent can change");
    const retried = await crane(store, "goals", "retry", first.id, active.tasks[0].taskId, "--revision", String(store.getGoal(first.id)!.revision), "--agent", "claude-code", "--model", "opus", "--json");
    assert.equal(retried.code, 0, retried.err);
    const retryGoal = JSON.parse(retried.out).goal;
    assert.equal(store.getTask(retryGoal.tasks[0].taskId)!.driver, "claude-code");
    assert.equal(store.getTask(retryGoal.tasks[0].taskId)!.model, "opus");
    const cancelled = await crane(store, "goals", "cancel", first.id, "--revision", String(retryGoal.revision), "--json");
    assert.equal(cancelled.code, 0, cancelled.err);
    assert.equal(JSON.parse(cancelled.out).goal.status, "cancelled");
    const human = await crane(store, "goals", "show", first.id);
    assert.equal(human.code, 0, human.err);
    assert.match(human.out, /Research: crane show/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cli: repos checks shows, replaces and clears a repo's checks", async () => {
  const { store, repo } = setup();
  try {
    assert.match((await crane(store, "repos", "checks", "app")).out, /can't pass review or merge/);

    const set = await crane(store, "repos", "checks", "app", "--set", " npm run lint ", "--set", "npm test");
    assert.equal(set.code, 0, set.err);
    assert.match(set.out, /Saved checks for app/);
    assert.deepEqual(store.repoChecks(repo.id), ["npm run lint", "npm test"]);

    const shown = await crane(store, "repos", "checks", "app", "--json");
    assert.deepEqual(JSON.parse(shown.out), ["npm run lint", "npm test"]);

    for (const args of [["--set", "  "], ["--set", "npm test", "--clear"]]) {
      assert.equal((await crane(store, "repos", "checks", "app", ...args)).code, 1, args.join(" "));
      assert.deepEqual(store.repoChecks(repo.id), ["npm run lint", "npm test"]);
    }
    assert.equal((await crane(store, "repos", "checks", "nope")).code, 1);
    assert.equal((await crane(store, "repos", "checks", "nope", "--set", "npm test")).code, 1);

    const cleared = await crane(store, "repos", "checks", "app", "--clear", "--json");
    assert.deepEqual(JSON.parse(cleared.out), []);
    assert.deepEqual(store.repoChecks(repo.id), []);
  } finally { store.close(); }
});

test("cli: repos remove disconnects a repo by name and refuses the factory's own or an unknown one", async () => {
  const { store, repo } = setup();
  try {
    const factory = store.addRepo({ path: "/factory", name: "crane", isFactory: true });
    const unknown = await crane(store, "repos", "remove", "nope");
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /No repo nope/);
    const own = await crane(store, "repos", "remove", "crane");
    assert.equal(own.code, 1);
    assert.match(own.err, /factory's own repo can't be removed/);
    assert.ok(store.getRepo(factory.id));

    const removed = await crane(store, "repos", "remove", "app");
    assert.equal(removed.code, 0, removed.err);
    assert.match(removed.out, /Disconnected app/);
    assert.equal(store.getRepo(repo.id), null);
  } finally { store.close(); }
});

test("cli: options from one run don't carry into the next in the same process", async () => {
  const { store } = setup();
  try {
    assert.equal((await crane(store, "repos", "checks", "app", "--set", "npm run lint", "--json")).code, 0);
    assert.equal((await crane(store, "repos", "checks", "app", "--set", "npm test")).code, 0);
    assert.deepEqual(store.repoChecks(store.getRepo("app")!.id), ["npm test"]);

    const shown = await crane(store, "repos", "checks", "app");
    assert.equal(shown.code, 0, shown.err);
    assert.doesNotMatch(shown.out, /Saved checks/);
    assert.match(shown.out, /Checks for app/);
  } finally { store.close(); }
});

test("cli: retention is opt-in, validates days and can be disabled", async () => {
  const { store } = setup();
  try {
    assert.match((await crane(store, "retention")).out, /disabled; keep all history/);
    const enabled = await crane(store, "retention", "--days", "30");
    assert.equal(enabled.code, 0, enabled.err);
    assert.match(enabled.out, /30 days after tasks finish/);
    assert.match(enabled.out, /permanently deletes/);
    assert.match(enabled.out, /VACUUM; back up first/);
    for (const days of ["0", "-1", "1.5", "Infinity", "lots", "36501"]) {
      assert.equal((await crane(store, "retention", "--days", days)).code, 1, days);
      assert.equal(store.retentionSettings().finishedTaskDays, 30);
    }
    assert.equal((await crane(store, "retention", "--days", "20", "--disable")).code, 1);
    assert.equal(store.retentionSettings().finishedTaskDays, 30);
    assert.equal((await crane(store, "retention", "--disable")).code, 0);
    assert.equal(store.retentionSettings().finishedTaskDays, null);
    assert.match((await crane(store, "retention")).out, /disabled; keep all history/);
  } finally { store.close(); }
});

test("cli: pre-approval discloses its visual waiver and undo restores the pending decision", async () => {
  const { store, task } = setup();
  const candidate = task("running");
  store.updateTask(candidate.id, { visualReview: { status: "pending", commit: "a".repeat(40), tree: "b".repeat(40), note: "UI changed", decidedAt: null } });
  try {
    const approved = await crane(store, "pre-approve", candidate.id);
    assert.equal(approved.code, 0);
    assert.match(approved.out, /visual review is waived, including conflict resolutions/);
    const show = await crane(store, "show", candidate.id);
    assert.match(show.out, /Visual review: waived by pre-approval/);
    assert.doesNotMatch(show.out, /Record inspection:/);
    assert.equal((await crane(store, "pre-approve", candidate.id, "--undo")).code, 0);
    const undone = await crane(store, "show", candidate.id);
    assert.match(undone.out, /Visual review: pending/);
    assert.match(undone.out, /Record inspection:/);
  } finally { store.close(); }
});

test("cli: queue lists pickup order, moves tasks, and rejects ambiguous or stale moves", async () => {
  const { store, task } = setup();
  try {
    const a = task("queued");
    const b = task("queued");
    const c = task("queued");
    const running = task("running");
    const list = async () => {
      const result = await crane(store, "queue", "--json");
      assert.equal(result.code, 0, result.err);
      return (JSON.parse(result.out) as { id: string }[]).map(m => m.id);
    };
    assert.deepEqual(await list(), [a.id, b.id, c.id]);
    const moved = await crane(store, "queue", c.id.slice(2), "--before", a.id.slice(2));
    assert.equal(moved.code, 0, moved.err);
    assert.match(moved.out, /Queue reordered/);
    assert.deepEqual(await list(), [c.id, a.id, b.id]);
    assert.equal((await crane(store, "queue", c.id, "--last")).code, 0);
    assert.deepEqual(await list(), [a.id, b.id, c.id]);
    for (const args of [[b.id], [b.id, "--last", "--before", a.id], ["--last"], ["--before", a.id],
      [running.id, "--before", a.id], [b.id, "--before", running.id]]) {
      assert.equal((await crane(store, "queue", ...args)).code, 1, args.join(" "));
      assert.deepEqual(await list(), [a.id, b.id, c.id]);
    }
  } finally { store.close(); }
});

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

test("cli: post-mortem crew is set by name, shown, kept by other changes, and reset with default", async () => {
  const { store } = setup();
  store.upsertAgent({ id: "a-jib", name: "Jib", driver: "simulated" });
  store.upsertAgent({ id: "a-hoist", name: "Hoist", driver: "simulated" });
  store.setSetting("crew_active_a-hoist", "false");
  try {
    assert.match((await crane(store, "agents", "postmortem")).out, /Run by any active member/);
    const set = await crane(store, "agents", "postmortem", "--crew", "hoist, Jib");
    assert.equal(set.code, 0, set.err);
    assert.match(set.out, /Run by Jib, Hoist \(on-call\)|Run by Hoist \(on-call\), Jib/);
    assert.deepEqual(store.postmortemCrew(), ["a-hoist", "a-jib"]);
    assert.match((await crane(store, "agents")).out, /On-call · default: factory default · runs post-mortems/);
    assert.equal((await crane(store, "agents", "postmortem", "--agent", "codex")).code, 0);
    assert.deepEqual(store.postmortemCrew(), ["a-hoist", "a-jib"], "changing the agent keeps the crew");
    for (const bad of ["ghost", "jib,ghost", " , "]) {
      assert.equal((await crane(store, "agents", "postmortem", "--crew", bad)).code, 1, bad);
      assert.deepEqual(store.postmortemCrew(), ["a-hoist", "a-jib"], "a refused change saves nothing");
    }
    const source = store.createTask({ kind: "maintenance", title: "Feature", brief: "", repoId: null, autonomy: "observe" });
    store.setStatus(source.id, "merging");
    const review = store.completeMerge(source.id, "Merged", {})!;
    assert.match((await crane(store, "show", review.id)).out, /for Jib, Hoist \(on-call\)|for Hoist \(on-call\), Jib/);
    const reset = await crane(store, "agents", "postmortem", "--crew", "default");
    assert.equal(reset.code, 0, reset.err);
    assert.deepEqual(store.postmortemCrew(), []);
    assert.match(reset.out, /Run by any active member/);
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

test("cli: show presents each finding's latest follow-up ID and current status", async () => {
  const { store, repo, task } = setup();
  try {
    const source = task("needs_review");
    store.updateTask(source.id, { report: { summary: "Review results", changedFiles: [], findings: [
      { title: "Fix the cache", detail: "Include the locale in the key.", impact: "high", effort: "small" },
      { title: "Name the flag", detail: "Explain what the flag controls.", impact: "low", effort: "small" },
      { title: "Add a timeout", detail: "Bound the wait.", impact: "medium", effort: "small" },
    ] } });
    const before = await crane(store, "show", source.id);
    assert.equal(before.code, 0, before.err);
    assert.doesNotMatch(before.out, /Follow-up /);

    // Create them out of finding order so presentation must use the finding index.
    const followUp = (finding: number) => store.createTask({ kind: "maintenance", title: "Follow-up work", brief: "",
      repoId: repo.id, autonomy: "propose", followUp: { of: source.id, finding } });
    const flag = followUp(1);
    const first = followUp(0);
    const queued = await crane(store, "show", source.id);
    assert.equal(queued.code, 0, queued.err);
    assert.match(queued.out, new RegExp(`1  Fix the cache[^\\n]*\\n[^\\n]*\\n     Follow-up ${first.id}  Queued`));
    assert.match(queued.out, new RegExp(`2  Name the flag[^\\n]*\\n[^\\n]*\\n     Follow-up ${flag.id}  Queued`));
    assert.equal(queued.out.split("\n").filter(line => line.trimStart().startsWith("Follow-up ")).length, 2);

    store.updateTask(first.id, { status: "failed" });
    const latest = followUp(0);
    store.updateTask(latest.id, { status: "running" });
    store.updateTask(flag.id, { status: "needs_review" });
    const updated = await crane(store, "show", source.id);
    assert.equal(updated.code, 0, updated.err);
    assert.match(updated.out, new RegExp(`1  Fix the cache[^\\n]*\\n[^\\n]*\\n     Follow-up ${latest.id}  Working`));
    assert.match(updated.out, new RegExp(`2  Name the flag[^\\n]*\\n[^\\n]*\\n     Follow-up ${flag.id}  Needs you`));
    assert.ok(!updated.out.includes(first.id), "the older attempt is no longer presented");
    assert.equal(updated.out.split("\n").filter(line => line.trimStart().startsWith("Follow-up ")).length, 2,
      "findings without follow-ups have no follow-up row");
  } finally { store.close(); }
});

test("cli: show links a follow-up back to its source task and finding", async () => {
  const { store, repo, task } = setup();
  try {
    const source = task("needs_review");
    store.updateTask(source.id, { report: { summary: "", changedFiles: [], findings: [
      { title: "Fix the cache", detail: "Include the locale in the key.", impact: "high", effort: "small" },
    ] } });
    const next = store.createTask({ kind: "maintenance", title: "Fix the cache", brief: "", repoId: repo.id, autonomy: "propose",
      followUp: { of: source.id, finding: 0 } });

    const r = await crane(store, "show", next.id);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`Follow-up to ${source.id}  needs_review task  Needs you`));
    assert.match(r.out, /Finding Fix the cache/);
    assert.doesNotMatch((await crane(store, "show", source.id)).out, /Follow-up to/);
  } finally { store.close(); }
});

test("cli: tasks --json lists open tasks by default, with branch, worktree and repo name", async () => {
  const { store, task } = setup();
  try {
    const open = task("needs_review");
    const report = { summary: "Full report", findings: [], changedFiles: ["a.ts"] };
    store.updateTask(open.id, { worktree: "/worktrees/x", report });
    const queued = task("queued", false);
    const done = task("merged");

    const parse = (out: string) => JSON.parse(out) as { id: string; status: string; branch: string | null; worktree: string | null; repo: string | null; brief: string; report: unknown }[];
    const r = await crane(store, "tasks", "--json");
    assert.equal(r.code, 0, r.err);
    const list = parse(r.out);
    assert.deepEqual(new Set(list.map((m) => m.id)), new Set([open.id, queued.id]));
    const row = list.find((m) => m.id === open.id)!;
    assert.equal(row.branch, `crane/${open.id}`);
    assert.equal(row.worktree, "/worktrees/x");
    assert.equal(row.repo, "app");
    assert.equal(row.brief, open.brief);
    assert.deepEqual(row.report, report, "CLI JSON retains the full report");

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

for (const command of ["serve", "start"]) {
  test(`cli: ${command} refuses a crew size or port that isn't a number, before starting anything`, async () => {
    const { store } = setup();
    try {
      const crew = await crane(store, command, "--agents", "lots", "--port", "4471");
      assert.equal(crew.code, 1);
      assert.match(crew.err, /--agents takes a number/);
      const port = await crane(store, command, "--agents", "2", "--port", "dashboard");
      assert.equal(port.code, 1);
      assert.match(port.err, /--port takes a number/);
      assert.equal(store.getSetting("crew_active_a-jib"), null, "the bad value was never saved over the crew");
    } finally {
      store.close();
    }
  });
}
