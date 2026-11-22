import type { TestContext } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EventType, RunnerJob } from "@crane/contracts";
import { REPORT_FENCE, type RunContext } from "@crane/agent-protocol";
import { OperatorActions } from "@crane/factory/actions";
import { Store, type RunnerRecord } from "@crane/storage";
import { createWorktree } from "../../packages/factory/src/git.js";
import { RemoteDriver } from "../../packages/factory/src/remote/driver.js";
import { temporaryRoot, testHome } from "./fixtures.js";
import { sh } from "./git.js";

/**
 * A repo with a running task in its own worktree (one commit of work on the
 * branch), a registered container that is online, and a RemoteDriver for it.
 * The tests play the container's part with plain git in a directory of its own.
 */
export async function remoteSetup(t: TestContext) {
  testHome(t);
  const root = temporaryRoot(t, "crane-remote-");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "start\n");
  sh(checkout, "add", ".");
  sh(checkout, "commit", "-q", "-m", "start");
  const store = new Store(join(root, "crane.db"));
  t.after(() => store.close());
  let now = Date.now();
  const clock = () => now;
  const actions = new OperatorActions(store, clock);
  const repo = await actions.connectRepo(checkout, "remote");
  const at = new Date(now).toISOString();
  const owner = store.access.createOperator({ username: "robin", name: "Robin", role: "operator", passwordHash: "unused", at });
  const { id: runnerId } = store.runners.create({ operatorId: owner.id, name: "laptop", tokenHash: "digest", at });
  store.runners.touch(runnerId, at);
  const task = actions.createTask({ kind: "maintenance", title: "Remote work", brief: "Do it remotely", repoId: repo.id, autonomy: "propose" });
  const wt = await createWorktree(repo, task);
  store.updateTask(task.id, { branch: wt.branch, worktree: wt.path });
  store.setStatus(task.id, "running", "Running");
  commitIn(wt.path, "first.txt", "local work\n", "local work");
  const driver = new RemoteDriver(store, runnerId, "claude-code", { pollMs: 5, now: clock });
  const events: { type: EventType; message: string }[] = [];
  const ac = new AbortController();
  const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
    task: store.getTask(task.id)!, repo, cwd: wt.path, signal: ac.signal,
    emit: (type, message) => events.push({ type, message }), ...extra,
  });
  const runner = (): RunnerRecord => store.runners.byId(runnerId)!;
  return { store, actions, repo, checkout, taskId: task.id, branch: wt.branch, wt: wt.path, driver, events, ac, ctx, runner,
    advance: (ms: number) => { now += ms; } };
}

export type RemoteSetup = Awaited<ReturnType<typeof remoteSetup>>;

export function commitIn(dir: string, file: string, content: string, message = `edit ${file}`): string {
  writeFileSync(join(dir, file), content);
  sh(dir, "add", file);
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD");
}

/** Wait for the driver to post its job, then claim it as the container. */
export async function claim(s: RemoteSetup): Promise<RunnerJob> {
  for (let i = 0; i < 1000; i++) {
    const job = s.actions.claimRunnerJob(s.runner());
    if (job) return job;
    await delay(5);
  }
  throw new Error("The driver never posted a job");
}

/** Wait for the driver to post its job, without claiming it. */
export async function posted(s: RemoteSetup) {
  for (let i = 0; i < 1000; i++) {
    const job = s.store.runners.openJobFor(s.taskId);
    if (job) return job;
    await delay(5);
  }
  throw new Error("The driver never posted a job");
}

/** The container's own clone: an empty repo holding what Crane sent. */
export async function containerClone(t: TestContext, s: RemoteSetup, job: RunnerJob): Promise<string> {
  const dir = temporaryRoot(t, "crane-container-");
  sh(dir, "init", "-q", "-b", "work");
  const sent = await s.actions.jobBundle(s.runner(), job.id);
  if (!sent) throw new Error("Crane sent nothing");
  sh(dir, "fetch", "-q", sent.path, "refs/crane/outgoing/*:refs/sent/*");
  sent.remove();
  return dir;
}

/** A bundle of `revs` from the container, as bytes for `returnJob`. */
export function bundleOf(dir: string, ...revs: string[]): Buffer {
  const path = join(dir, ".git", `${Math.random().toString(36).slice(2)}.bundle`);
  sh(dir, "bundle", "create", "-q", path, ...revs);
  return readFileSync(path);
}

/** A final message ending in a crane-report block. */
export function finalText(report: Record<string, unknown>): string {
  return `Finished.\n\n\`\`\`${REPORT_FENCE}\n${JSON.stringify(report)}\n\`\`\``;
}
