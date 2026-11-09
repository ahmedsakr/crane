import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunError, type AgentDriver, type AgentJob } from "@crane/agent-protocol";
import { Store } from "@crane/storage";
import { runAgent } from "../packages/factory/src/agent-runner.js";
import { resumePrompt, systemPrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";

const markerScan = "git grep -nE '^(<<<<<<<|>>>>>>>|=======$)' -- ':!*.md'";

test("durable refusals reach every phase, resumed and fresh fallback prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "crane-refusals-"));
  const path = join(root, "crane.db");
  let store = new Store(path);
  try {
    const task = store.createTask({ kind: "maintenance", title: "Resolve", brief: "", repoId: null, autonomy: "propose" });
    const other = store.createTask({ kind: "maintenance", title: "Other", brief: "", repoId: null, autonomy: "observe" });
    const event = store.addEvent(task.id, "blocked", "Blocked marker search and staging", {
      tool: "Bash", command: `${markerScan} && git add file.ts`, rules: [],
    });
    store.addEvent(other.id, "blocked", "Other task refusal", { tool: "Bash", command: "other-secret-command", rules: [] });
    for (let i = 0; i < 60; i++) store.addEvent(task.id, "tool", "Noisy later tool event");
    store.close();
    store = new Store(path);
    const priorRefusals = store.priorRefusals(task.id);
    assert.equal(priorRefusals.length, 1);
    assert.equal(priorRefusals[0]!.id, event.id);
    const jobs: (AgentJob | undefined)[] = [undefined,
      { kind: "resolve_conflicts", phase: "edit", base: "main", files: ["file.ts"] },
      { kind: "resolve_conflicts", phase: "validate", checkpoint: "saved", base: "main", files: ["file.ts"] },
      { kind: "fix_checks", base: "main", commit: "saved", failures: [] },
    ];
    for (const job of jobs) {
      for (const prompt of [userPrompt(task, job, { priorRefusals }), resumePrompt({ task, job, priorRefusals })]) {
        assert.ok(prompt.includes(markerScan));
        assert.ok(prompt.includes(`"eventId":${event.id}`));
        assert.match(prompt, /"reason":null/);
        assert.match(prompt, /missing reason remains unknown/);
        assert.match(prompt, /marker scan as unavailable rather than substituting Grep/);
        assert.doesNotMatch(prompt, /other-secret-command/);
      }
      assert.match(systemPrompt(task, null, job), /equivalent native-tool call/);
      assert.match(systemPrompt(task, null, job), /do not guess which part was denied/);
    }
    assert.doesNotMatch(userPrompt(task), /## Prior refusals/);
    for (let i = 0; i < 45; i++) store.addEvent(task.id, "blocked", "x".repeat(9000), {
      tool: "Bash", command: `TOKEN=hide-me\n${"x".repeat(9000)}`, rules: ["Do not infer a reason from this"],
      refusal: { reason: "Password=hide-me" },
    });
    const bounded = store.priorRefusals(task.id);
    assert.equal(bounded.length, 40);
    const prompt = userPrompt(task, undefined, { priorRefusals: bounded });
    assert.ok(prompt.length < 22000);
    assert.doesNotMatch(prompt, /hide-me|Do not infer a reason from this/);
    assert.match(prompt, /older entries may be omitted/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner refreshes refusals between editing, validation and transient retries", async () => {
  const store = new Store(":memory:");
  try {
    const task = store.createTask({ kind: "maintenance", title: "Resolve", brief: "", repoId: null, autonomy: "propose" });
    store.upsertAgent({ id: "refusal-agent", name: "Resolver", driver: "test" });
    let attempts = 0;
    const driver: AgentDriver = { name: "test", label: "Test", available: async () => true, run: async (ctx) => {
      attempts++;
      if (ctx.job?.kind === "resolve_conflicts" && ctx.job.phase === "edit") {
        assert.deepEqual(ctx.priorRefusals, []);
        store.addEvent(task.id, "blocked", "Marker scan refused", { tool: "Bash", command: markerScan, rules: [] });
      } else {
        assert.ok(userPrompt(ctx.task, ctx.job, ctx).includes(markerScan));
        if (attempts === 2) {
          store.addEvent(task.id, "blocked", "Native tool refused", { tool: "Grep", rules: [] });
          throw new AgentRunError("API Error: 503", { transient: true, sessionId: "retry" });
        }
        assert.equal(ctx.resumeSession, "retry");
        assert.match(resumePrompt(ctx), /Native tool refused/);
      }
      return { report: { summary: "Done", findings: [], changedFiles: [] } };
    } };
    for (const phase of ["edit", "validate"] as const) {
      await runAgent({ store, maxTurns: 0, retryDelayMs: 1 }, "refusal-agent", driver, {
        task, repo: null, cwd: "/unused", signal: new AbortController().signal, emit: () => {},
        job: { kind: "resolve_conflicts", phase, base: "main", files: ["file.ts"] },
      });
    }
    assert.equal(attempts, 3);
  } finally { store.close(); }
});
