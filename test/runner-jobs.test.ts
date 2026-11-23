import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRunError } from "@crane/agent-protocol";
import { RUNNER_LIMITS } from "@crane/contracts";
import { AccessError } from "@crane/factory/actions";
import { claim, posted, remoteSetup } from "./support/remote-fixture.js";

const fromJob = (data: Record<string, unknown> | null, jobId: string) => data?.runnerJob === jobId;

test("runner jobs: only note, tool, finding, error and blocked events reach the activity log, capped", async (t) => {
  const s = await remoteSetup(t);
  const run = s.driver.run(s.ctx());
  const job = await claim(s);
  const long = "x".repeat(RUNNER_LIMITS.eventMessageChars + 50);
  const { accepted } = s.actions.appendJobEvents(s.runner(), job.id, {
    events: [
      { type: "note", message: long, data: { actor: { kind: "operator", name: "Mallory" }, validation: { status: "passed" }, step: 1 } },
      { type: "tool", message: "Ran ls" },
      { type: "finding", message: "Found a thing" },
      { type: "error", message: "Oops" },
      { type: "blocked", message: "Refused rm" },
      { type: "status", message: "Merged" },
      { type: "operator", message: "Approved by operator" },
      { type: "note", message: 42 },
      { type: "note", message: "too big", data: { blob: "y".repeat(20_000) } },
      "junk",
    ],
  });
  assert.equal(accepted, 6);
  const events = s.store.listEvents(s.taskId).filter((e) => fromJob(e.data, job.id));
  assert.deepEqual(events.map((e) => e.type), ["note", "tool", "finding", "error", "blocked", "note"]);
  assert.equal(events[0]!.message.length, RUNNER_LIMITS.eventMessageChars);
  assert.deepEqual(events[0]!.data, { step: 1, runnerJob: job.id }, "Crane's own data keys are dropped");
  assert.deepEqual(events[5]!.data, { runnerJob: job.id, truncated: true });

  const many = Array.from({ length: RUNNER_LIMITS.eventsPerBatch + 10 }, (_, i) => ({ type: "tool", message: `call ${i}` }));
  assert.equal(s.actions.appendJobEvents(s.runner(), job.id, { events: many }).accepted, RUNNER_LIMITS.eventsPerBatch);
  s.ac.abort();
  await assert.rejects(run);
});

test("runner jobs: another container can't touch a job, and a finished one takes nothing more", async (t) => {
  const s = await remoteSetup(t);
  const run = s.driver.run(s.ctx());
  const job = await claim(s);
  const owner = s.store.access.createOperator({ username: "sam", name: "Sam", role: "operator", passwordHash: "x", at: new Date().toISOString() });
  const other = s.store.runners.create({ operatorId: owner.id, name: "desk", tokenHash: "other", at: new Date().toISOString() });
  const refused = { name: AccessError.name, status: 404 };
  assert.throws(() => s.actions.appendJobEvents(other, job.id, { events: [{ type: "note", message: "hi" }] }), refused);
  assert.throws(() => s.actions.returnJob(other, job.id, { outcome: "succeeded" }), refused);
  assert.throws(() => s.actions.recordJobSession(other, job.id, "abc"), refused);
  await assert.rejects(s.actions.jobBundle(other, job.id), refused);
  assert.deepEqual(s.actions.runnerHeartbeat(other, { drivers: [], capacity: 1, version: "1", jobs: [job.id] }).cancel, [job.id]);
  assert.throws(() => s.actions.returnJob(s.runner(), job.id, { outcome: "maybe" }), /succeeded or failed/);

  s.actions.recordJobSession(s.runner(), job.id, "session-1");
  s.actions.returnJob(s.runner(), job.id, { outcome: "failed", error: { message: "it broke", transient: false } });
  await assert.rejects(run, (err) => err instanceof AgentRunError && /it broke/.test(err.message) && err.sessionId === "session-1");
  assert.throws(() => s.actions.appendJobEvents(s.runner(), job.id, { events: [] }), /no longer running/);
});

test("runner jobs: an oversized return fails the job with a task note and writes nothing", async (t) => {
  const s = await remoteSetup(t);
  const head = s.store.getTask(s.taskId)!;
  const run = s.driver.run(s.ctx());
  const job = await claim(s);
  const huge = { byteLength: RUNNER_LIMITS.bundleBytes + 1 } as Uint8Array;
  assert.throws(() => s.actions.returnJob(s.runner(), job.id, { outcome: "succeeded" }, huge), /more than the 256 MB/);
  await assert.rejects(run, /more than the 256 MB/);
  assert.equal(s.store.runners.job(job.id)!.state, "failed");
  assert.ok(s.store.listEvents(s.taskId).some((e) => e.type === "note" && /^Refused the container's commits/.test(e.message)));
  assert.equal(s.store.getTask(s.taskId)!.branch, head.branch);
});

test("runner jobs: aborting the run (stopping the factory) cancels the job, and the heartbeat says stop", async (t) => {
  const s = await remoteSetup(t);
  const run = s.driver.run(s.ctx());
  const job = await claim(s);
  assert.deepEqual(s.actions.runnerHeartbeat(s.runner(), { drivers: ["claude-code"], capacity: 1, version: "1", jobs: [job.id] }).cancel, []);
  s.ac.abort();
  await assert.rejects(run, (err) => err instanceof AgentRunError && !err.transient);
  assert.equal(s.store.runners.job(job.id)!.state, "cancelled");
  assert.deepEqual(s.actions.runnerHeartbeat(s.runner(), { drivers: ["claude-code"], capacity: 1, version: "1", jobs: [job.id] }).cancel, [job.id]);
});

test("runner jobs: cancelling the task cancels its job", async (t) => {
  const s = await remoteSetup(t);
  const run = s.driver.run(s.ctx());
  const job = await posted(s);
  s.actions.cancel(s.taskId);
  assert.equal(s.store.runners.job(job.id)!.state, "cancelled");
  await assert.rejects(run, /was cancelled/);
});

test("runner jobs: an expired lease ends the run as transient, naming the container", async (t) => {
  const s = await remoteSetup(t);
  const run = s.driver.run(s.ctx());
  const job = await claim(s);
  s.advance((RUNNER_LIMITS.leaseSeconds + 1) * 1000);
  await assert.rejects(run, (err) => err instanceof AgentRunError && err.transient && /Robin's container 'laptop' stopped answering/.test(err.message));
  assert.equal(s.store.runners.job(job.id)!.state, "expired");
});

test("runner jobs: a container that stays offline ends the run as transient", async (t) => {
  const s = await remoteSetup(t);
  const run = s.driver.run(s.ctx());
  const job = await posted(s);
  s.advance((RUNNER_LIMITS.offlineAfterSeconds + 1) * 1000);
  await assert.rejects(run, (err) => err instanceof AgentRunError && err.transient && /Robin's container 'laptop' is offline/.test(err.message));
  assert.equal(s.store.runners.job(job.id)!.state, "expired");
});

test("runner jobs: screenshots need a safe name and stay within the caps", async (t) => {
  const s = await remoteSetup(t);
  const run = s.driver.run(s.ctx());
  const job = await claim(s);
  const png = Buffer.from([1, 2, 3]);
  assert.throws(() => s.actions.storeJobScreenshot(s.runner(), job.id, "../escape.png", png), /Name the screenshot/);
  assert.throws(() => s.actions.storeJobScreenshot(s.runner(), job.id, "shot.sh", png), /Name the screenshot/);
  for (let i = 0; i < RUNNER_LIMITS.screenshotCount; i++) s.actions.storeJobScreenshot(s.runner(), job.id, `s${i}.png`, png);
  assert.throws(() => s.actions.storeJobScreenshot(s.runner(), job.id, "more.png", png), /at most 12/);
  s.ac.abort();
  await assert.rejects(run);
});
