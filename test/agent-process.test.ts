import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { AgentRunError } from "@crane/agent-protocol";
import {
  runAgentProcess,
  runResumingSession,
  SessionNotResumed,
  type AgentExit,
  type AgentProcess,
} from "../packages/agent-drivers/src/agent-process.js";

const REPORT = { report: { summary: "ok", findings: [], changedFiles: [] } };

function recordingStream() {
  const stream = {
    messages: [] as Record<string, unknown>[],
    exits: [] as AgentExit[],
    processErrors: 0,
    handle(msg: Record<string, unknown>) {
      stream.messages.push(msg);
      if (msg.bad) throw new Error("surprising");
    },
    onProcessError() {
      stream.processErrors++;
    },
    finish(exit: AgentExit) {
      stream.exits.push(exit);
      return REPORT;
    },
  };
  return stream;
}

function processFor(script: string, stream: AgentProcess["stream"], signal = new AbortController().signal) {
  const notes: string[] = [];
  const run: AgentProcess = {
    bin: process.execPath,
    label: "Fake",
    args: ["-e", script],
    env: process.env,
    prompt: "the prompt",
    stream,
    ctx: { cwd: process.cwd(), signal, emit: (_type, message) => void notes.push(message) },
  };
  return { run, notes };
}

test("agent process: messages reach the stream, the prompt reaches stdin, and finish decides", async () => {
  const stream = recordingStream();
  const script = `
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      console.log("not json");
      console.log(JSON.stringify({ input }));
      process.exit(4);
    });`;
  const { run } = processFor(script, stream);
  assert.deepEqual(await runAgentProcess(run), REPORT);
  assert.deepEqual(stream.messages, [{ input: "the prompt" }]);
  assert.deepEqual(stream.exits, [{ code: 4, stderr: "" }]);
});

test("agent process: finish keeps the last 4000 characters of stderr", async () => {
  const stream = recordingStream();
  const { run } = processFor(`process.stderr.write("a".repeat(4500) + "z".repeat(1000))`, stream);
  await runAgentProcess(run);
  assert.equal(stream.exits[0]!.stderr, "a".repeat(3000) + "z".repeat(1000));
});

test("agent process: a throw from finish rejects the run", async () => {
  const failure = new AgentRunError("no good");
  const stream = { handle() {}, finish: () => { throw failure; } };
  await assert.rejects(runAgentProcess(processFor("", stream).run), (err) => err === failure);
});

test("agent process: a surprising message is told once and costs only itself", async () => {
  const stream = recordingStream();
  const script = `for (const m of [{ bad: 1 }, { bad: 2 }, { good: 3 }]) console.log(JSON.stringify(m))`;
  const { run, notes } = processFor(script, stream);
  await runAgentProcess(run);
  assert.equal(stream.messages.length, 3);
  assert.deepEqual(notes, ["Skipped a message Crane couldn't read from Fake: surprising"]);
});

test("agent process: a CLI that can't start names itself and tells the stream", async () => {
  const stream = recordingStream();
  const { run } = processFor("", stream);
  run.bin = "/nonexistent/fake-agent";
  await assert.rejects(runAgentProcess(run), /^Error: Could not start Fake \(\/nonexistent\/fake-agent\): .*ENOENT/);
  assert.equal(stream.processErrors, 1);
});

test("agent process: already cancelled means nothing is spawned", async () => {
  const stream = recordingStream();
  const controller = new AbortController();
  controller.abort();
  const { run } = processFor("", stream, controller.signal);
  run.bin = "/nonexistent/fake-agent";
  run.resume = "old-session";
  await assert.rejects(runAgentProcess(run), (err: AgentRunError) =>
    err instanceof AgentRunError && err.message === "Cancelled by operator" && err.sessionId === "old-session");
  assert.equal(stream.processErrors, 0);
  assert.deepEqual(stream.exits, []);
});

test("agent process: the abort listener is gone once the process has closed", async () => {
  const controller = new AbortController();
  await runAgentProcess(processFor("", recordingStream(), controller.signal).run);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const failing = processFor("", recordingStream(), controller.signal);
  failing.run.bin = "/nonexistent/fake-agent";
  await assert.rejects(runAgentProcess(failing.run));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("agent process: an abort sends SIGTERM, which an obliging CLI stops on", async () => {
  const controller = new AbortController();
  const stream = recordingStream();
  const { run } = processFor(`console.log("{}"); setTimeout(() => {}, 60000);`, {
    ...stream,
    handle: () => controller.abort(),
    finish: (exit) => stream.finish(exit),
  }, controller.signal);
  await runAgentProcess(run);
  assert.deepEqual(stream.exits, [{ code: null, stderr: "" }]);
});

function resumeContext(resumeSession?: string, signal = new AbortController().signal) {
  const notes: string[] = [];
  return { notes, ctx: { resumeSession, signal, emit: (_type: string, message: string) => void notes.push(message) } };
}

test("resuming: no earlier session runs once, fresh", async () => {
  const { ctx, notes } = resumeContext();
  const calls: (string | undefined)[] = [];
  await runResumingSession(ctx, async (resume) => { calls.push(resume); return REPORT; });
  assert.deepEqual(calls, [undefined]);
  assert.deepEqual(notes, []);
});

test("resuming: a lost session starts a new one, and says so", async () => {
  const { ctx, notes } = resumeContext("old");
  const calls: (string | undefined)[] = [];
  const result = await runResumingSession(ctx, async (resume) => {
    calls.push(resume);
    if (resume) throw new SessionNotResumed("gone");
    return REPORT;
  });
  assert.equal(result, REPORT);
  assert.deepEqual(calls, ["old", undefined]);
  assert.deepEqual(notes, ["Couldn't pick up the agent's earlier session, so it's starting a new one on the work so far"]);
});

test("resuming: other failures, and a cancelled run, aren't retried", async () => {
  const other = new AgentRunError("no good");
  let calls = 0;
  await assert.rejects(runResumingSession(resumeContext("old").ctx, async () => { calls++; throw other; }), (err) => err === other);
  assert.equal(calls, 1);

  const controller = new AbortController();
  controller.abort();
  const lost = new SessionNotResumed("gone");
  calls = 0;
  await assert.rejects(runResumingSession(resumeContext("old", controller.signal).ctx, async () => { calls++; throw lost; }), (err) => err === lost);
  assert.equal(calls, 1);
});
