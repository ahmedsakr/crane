import "../src/application.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SimulatedDriver } from "@crane/agent-drivers";
import type { DriverName, RunnerJob } from "@crane/contracts";
import { OperatorActions } from "@crane/factory/actions";
import { Factory } from "@crane/factory/runtime";
import { Store } from "@crane/storage";
import { runAgent } from "../packages/factory/src/agent-runner.js";
import { driverFor } from "../packages/factory/src/driver-selection.js";
import { createWorktree } from "../packages/factory/src/git.js";
import { RemoteDriver } from "../packages/factory/src/remote/driver.js";
import { waitingReturn } from "../packages/factory/src/runner-lane.js";
import { onFixtureCleanup, temporaryRoot, testHome } from "./support/fixtures.js";
import { sh } from "./support/git.js";
import { bundleOf, commitIn, finalText } from "./support/remote-fixture.js";

const until = async (ok: () => boolean, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await delay(10);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

/**
 * A repo, an operator's container that is online with Claude Code and Codex
 * signed in, and a stub that plays the container's part through the same
 * actions the container API calls: it claims jobs and returns them, without a bundle.
 */
async function laneSetup(t: TestContext, opts: { capacity?: number; online?: boolean } = {}) {
  testHome(t);
  const root = temporaryRoot(t, "crane-lane-");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  commitIn(checkout, "README.md", "start\n", "start");
  const store = new Store(join(root, "crane.db"));
  onFixtureCleanup(t, () => store.close());
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "lane");
  store.setRepoChecks(repo.id, ["true"]);
  const at = new Date().toISOString();
  const owner = store.access.createOperator({ username: "robin", name: "Robin", role: "operator", passwordHash: "unused", at });
  const capacity = opts.capacity ?? 1;
  const runnerId = store.runners.create({ operatorId: owner.id, name: "laptop", tokenHash: "digest", capacity, at }).id;
  const runner = () => store.runners.byId(runnerId)!;
  const drivers: DriverName[] = ["claude-code", "codex"];
  const heartbeat = () => actions.runnerHeartbeat(runner(), { drivers, capacity, version: "test" });
  if (opts.online !== false) heartbeat();
  const routed = (title: string) => {
    const task = actions.createTask({ kind: "maintenance", title, brief: title, repoId: repo.id, autonomy: "propose" });
    store.updateTask(task.id, { runnerId });
    return task.id;
  };
  const local = (title: string) => actions.createTask({ kind: "maintenance", title, brief: title, repoId: repo.id, autonomy: "propose" }).id;
  const factory = (crewSize = 1) => {
    const f = new Factory(store, new SimulatedDriver(5), { crewSize, tickMs: 10, remotePollMs: 5 });
    onFixtureCleanup(t, () => f.stop({ graceMs: 2000 }));
    return f;
  };
  /** Claim the container's next job, waiting for the factory to post one. */
  const claimNext = async (): Promise<RunnerJob> => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const job = actions.claimRunnerJob(runner());
      if (job) return job;
      await delay(10);
    }
    throw new Error("The factory never sent a job");
  };
  const finish = (job: RunnerJob, summary: string) =>
    actions.returnJob(runner(), job.id, { outcome: "succeeded", finalText: finalText({ summary, findings: [], changedFiles: [] }) });
  const fail = (job: RunnerJob, message: string) =>
    actions.returnJob(runner(), job.id, { outcome: "failed", error: { message, transient: false } });
  const status = (id: string) => store.getTask(id)!.status;
  const messages = (id: string) => store.listEvents(id).map((e) => e.message);
  return { root, checkout, store, actions, repo, runnerId, owner, heartbeat, routed, local, factory, claimNext, finish, fail, status, messages };
}

test("runner lane: container tasks run beside the crew, as many at once as the container's capacity", async (t) => {
  const s = await laneSetup(t, { capacity: 2 });
  const routed = [s.routed("One"), s.routed("Two"), s.routed("Three")];
  const local = s.local("Local");
  s.factory(1).start();

  await until(() => routed.filter((id) => s.status(id) === "running").length === 2, "two container tasks to start");
  const [first, second] = [await s.claimNext(), await s.claimNext()];
  // The only crew member is free for local work while the container holds both its slots.
  await until(() => s.status(local) === "needs_review", "the local task to finish");
  await delay(100);
  const waiting = routed.filter((id) => s.status(id) === "queued");
  assert.equal(waiting.length, 1, "the third waits for a free slot");
  assert.equal(s.store.runners.openJobFor(waiting[0]!), null, "and isn't sent yet");
  const running = routed.filter((id) => s.status(id) === "running").map((id) => s.store.getTask(id)!);
  assert.ok(running.every((task) => task.agentId?.startsWith(`r-${s.runnerId}-`)), "lane slots, not crew, hold them");
  assert.deepEqual(s.store.listAgents().map((a) => a.id).filter((id) => !id.startsWith("a-")), [], "lane slots get no crew rows");
  assert.equal(s.store.getTask(local)!.agentId?.startsWith("a-"), true);

  s.finish(first, "Did one");
  const third = await s.claimNext();
  assert.equal(third.taskId, waiting[0]);
  s.finish(second, "Did two");
  s.finish(third, "Did three");
  await until(() => routed.every((id) => s.status(id) === "needs_review"), "every container task to finish");
  for (const id of routed) {
    const [run] = s.store.listRuns(id);
    assert.equal(run!.runnerId, s.runnerId, "the run is recorded against its container");
    assert.match(run!.agentId!, /^r-/);
  }
  assert.equal(s.store.listAgents().reduce((n, a) => n + a.tasksCompleted, 0), 1, "only the crew's own task counts toward the crew");
});

test("runner lane: an offline container's tasks wait queued until it checks in", async (t) => {
  const s = await laneSetup(t, { online: false });
  const id = s.routed("Wait for me");
  s.factory(2).start();
  await delay(150);
  assert.equal(s.status(id), "queued");
  assert.equal(s.store.runners.openJobFor(id), null, "nothing is sent to it");
  assert.equal(s.store.listRuns(id).length, 0, "and the crew doesn't take it");

  s.heartbeat();
  const job = await s.claimNext();
  assert.equal(job.taskId, id);
  s.finish(job, "Done once online");
  await until(() => s.status(id) === "needs_review", "the task to finish");
});

test("runner lane: a restart leaves a task with a live lease running, and waits on the same job", async (t) => {
  const s = await laneSetup(t);
  const id = s.routed("Keep going");
  const first = s.factory();
  first.start();
  const job = await s.claimNext();
  await first.stop();
  assert.equal(s.status(id), "running", "not requeued while its container works on it");
  assert.equal(s.store.runners.job(job.id)!.state, "claimed", "its container wasn't told to stop");

  s.factory().start();
  assert.equal(s.status(id), "running");
  assert.ok(s.messages(id).includes("The factory restarted while its container kept working on it"));
  await until(() => s.messages(id).some((m) => /^Back with Robin's container 'laptop'/.test(m)), "the lane to wait on the job again");
  assert.equal(s.store.runners.openJobFor(id)!.id, job.id, "the work isn't sent twice");
  s.finish(job, "Carried on through the restart");
  await until(() => s.status(id) === "needs_review", "the task to finish");
  assert.equal(s.store.getTask(id)!.report!.summary, "Carried on through the restart");
});

test("runner lane: work a container returned while the factory was down is applied, not sent again", async (t) => {
  const s = await laneSetup(t);
  const id = s.routed("Return while down");
  const first = s.factory();
  first.start();
  const job = await s.claimNext();
  await first.stop();

  // The container finishes while no factory is running, then goes offline.
  const dir = temporaryRoot(t, "crane-lane-container-");
  sh(dir, "init", "-q", "-b", "work");
  const sent = (await s.actions.jobBundle(s.store.runners.byId(s.runnerId)!, job.id))!;
  sh(dir, "fetch", "-q", sent.path, "refs/crane/outgoing/*:refs/sent/*");
  sent.remove();
  const start = job.tip ?? job.base;
  sh(dir, "checkout", "-q", "--detach", start);
  const returned = commitIn(dir, "remote.txt", "from the container\n");
  sh(dir, "update-ref", "refs/heads/result", "HEAD");
  s.actions.returnJob(s.store.runners.byId(s.runnerId)!, job.id, {
    outcome: "succeeded", finalText: finalText({ summary: "Returned while down", findings: [], changedFiles: ["remote.txt"] }),
  }, bundleOf(dir, "refs/heads/result", `^${start}`));
  s.store.runners.touch(s.runnerId, new Date(Date.now() - 3_600_000).toISOString());
  assert.equal(waitingReturn(s.store, id)?.id, job.id, "its bundle waits to be applied");

  s.factory().start();
  assert.equal(s.status(id), "running", "not requeued to be sent again");
  assert.ok(s.messages(id).includes("The factory restarted after its container returned its work"));
  await until(() => s.status(id) === "needs_review", "the returned work to be applied");
  assert.ok(s.messages(id).some((m) => /^Applying what Robin's container 'laptop' returned while the factory was down/.test(m)));
  assert.equal(s.store.runners.latestJobFor(id)!.id, job.id, "no second job was sent");
  const task = s.store.getTask(id)!;
  assert.equal(sh(task.worktree!, "rev-parse", "HEAD"), returned);
  assert.equal(task.report!.summary, "Returned while down");
  assert.equal(waitingReturn(s.store, id), null, "the bundle is used up");
});

test("runner lane: a restart requeues a container task whose lease ran out", async (t) => {
  const s = await laneSetup(t);
  const id = s.routed("Lost lease");
  const old = new Date(Date.now() - 400_000).toISOString();
  const stale = s.store.runners.createJob({ taskId: id, runnerId: s.runnerId, kind: "work", payload: { driver: "claude-code" }, at: old });
  s.store.runners.claimJob(s.runnerId, old);
  s.store.setStatus(id, "running", "Picked up");
  s.factory().start();
  assert.ok(s.messages(id).some((m) => /^The factory stopped unexpectedly/.test(m)));
  const job = await s.claimNext();
  assert.notEqual(job.id, stale.id, "sent again");
  assert.equal(s.store.runners.job(stale.id)!.state, "expired");
  s.finish(job, "Started over");
  await until(() => s.status(id) === "needs_review", "the task to finish");
});

/** Record a finished work run of the task with a session, on `runnerId` (null for the crew). */
function earlierRun(store: Store, taskId: string, driver: DriverName, runnerId: string | null, session: string) {
  store.updateTask(taskId, { sessionId: session });
  const run = store.startRun({ taskId, kind: "work", agentId: runnerId ? `r-${runnerId}-0` : "a-jib", driver, runnerId });
  store.finishRun(run, "succeeded", null);
}

test("runner lane: a session resumes only on the same container and agent", async (t) => {
  const s = await laneSetup(t, { capacity: 3 });
  const other = s.store.runners.create({ operatorId: s.owner.id, name: "desk", tokenHash: "other", at: new Date().toISOString() });
  const same = s.routed("Same container");
  const moved = s.routed("Other container");
  const crew = s.routed("Was on the crew");
  earlierRun(s.store, same, "codex", s.runnerId, "same-session");
  earlierRun(s.store, moved, "claude-code", other.id, "moved-session");
  earlierRun(s.store, crew, "claude-code", null, "crew-session");
  s.factory().start();

  const jobs = new Map<string, RunnerJob>();
  for (let i = 0; i < 3; i++) {
    const job = await s.claimNext();
    jobs.set(job.taskId, job);
  }
  assert.equal(jobs.get(same)!.resumeSession, "same-session");
  assert.equal(jobs.get(same)!.driver, "codex", "the agent that holds the session there");
  assert.equal(jobs.get(moved)!.resumeSession, undefined);
  assert.equal(jobs.get(crew)!.resumeSession, undefined);
  for (const id of [moved, crew]) {
    assert.ok(s.messages(id).includes("Switching to Claude Code on this task's container, which starts a new session on the work so far"));
  }
  assert.ok(!s.messages(same).some((m) => m.startsWith("Switching to")));
  for (const job of jobs.values()) s.finish(job, "Done");
  await until(() => [same, moved, crew].every((id) => s.status(id) === "needs_review"), "every task to finish");
});

test("runner lane: a container task's conflict resolution is sent to its container", async (t) => {
  const s = await laneSetup(t);
  const id = s.routed("Clash");
  const wt = await createWorktree(s.repo, s.store.getTask(id)!);
  commitIn(wt.path, "README.md", "task side\n");
  commitIn(s.checkout, "README.md", "main side\n");
  s.store.updateTask(id, { branch: wt.branch, worktree: wt.path, report: { summary: "Changed the readme", findings: [], changedFiles: ["README.md"] } });
  // Approved: what approval checks is covered elsewhere; this is about where the resolver runs.
  s.store.setStatus(id, "merging", "Approved");
  s.factory().start();

  const job = await s.claimNext();
  assert.equal(job.taskId, id);
  assert.equal(job.kind, "resolve_conflicts");
  assert.equal(job.job?.kind, "resolve_conflicts");
  s.fail(job, "Couldn't decide");
  await until(() => s.status(id) === "needs_review", "the merge to come back");
  const run = s.store.listRuns(id).find((r) => r.kind === "resolve_conflicts");
  assert.equal(run?.runnerId, s.runnerId);
  assert.ok(s.messages(id).some((m) => /Couldn't decide/.test(m)));
});

test("runner lane: a container task's check fix is sent to its container, and a removed container stops it", async (t) => {
  const s = await laneSetup(t);
  const id = s.routed("Fix checks");
  const task = s.store.getTask(id)!;
  const wt = await createWorktree(s.repo, task);
  const commit = commitIn(wt.path, "README.md", "merged\n");
  const driver = driverFor(s.store, new Map(), task, "a-jib", { pollMs: 5 });
  assert.ok(driver instanceof RemoteDriver);
  assert.equal(driver.runnerId, s.runnerId);
  assert.equal(driver.name, "claude-code", "the container's first agent");

  const ac = new AbortController();
  const run = runAgent({ store: s.store, maxTurns: 0, retryDelayMs: 1 }, "a-jib", driver, {
    task, repo: s.repo, cwd: wt.path, signal: ac.signal, emit: () => {},
    job: { kind: "fix_checks", base: "main", commit, failures: [{ command: "npm test", exitCode: 1, logs: "boom" }] },
  });
  const job = await s.claimNext();
  assert.equal(job.kind, "fix_checks");
  assert.equal(job.base, commit);
  s.fail(job, "No fix");
  await assert.rejects(run, /No fix/);
  assert.equal(s.store.listRuns(id).at(-1)!.runnerId, s.runnerId);

  s.store.runners.revoke(s.runnerId, new Date().toISOString());
  assert.throws(() => driverFor(s.store, new Map(), task, "a-jib"),
    /^Error: This task's container was removed\. Choose another container or the factory's crew from Change agent$/);
});
