import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task, VisualReview } from "@crane/contracts";
import { AgentRunError, type AgentDriver, type AgentJob } from "@crane/agent-protocol";
import { Store } from "../src/core/store.js";
import { runAgent } from "../src/factory/agent-runner.js";
import { resumePrompt, systemPrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";

function prompts(task: Task, job?: AgentJob): string[] {
  return [userPrompt(task, job), resumePrompt({ task, job })];
}

test("visual handoffs expose pre-approval for work, resolver edits, validation and resumed sessions", () => {
  const store = new Store(":memory:");
  try {
    const original = store.createTask({ kind: "maintenance", title: "UI", brief: "Change UI", repoId: null, autonomy: "propose" });
    const task = { ...original, preApprovedAt: "2026-11-03T10:00:00Z", report: {
      summary: "Operator must inspect screenshots before approval", findings: [], changedFiles: ["web/src/Home.tsx"],
    } };
    const jobs: (AgentJob | undefined)[] = [undefined,
      { kind: "resolve_conflicts", phase: "edit", base: "main", files: ["web/src/Home.tsx"] },
      { kind: "resolve_conflicts", phase: "validate", checkpoint: "db98771b", base: "main", files: ["web/src/Home.tsx"] },
      { kind: "fix_checks", base: "main", commit: "f1x0c4e", failures: [{ command: "npm test", exitCode: 1, logs: "not ok 1" }] },
    ];
    for (const job of jobs) {
      for (const prompt of prompts(task, job)) {
        assert.match(prompt, /Operator pre-approval: 2026-11-03T10:00:00Z/);
        assert.match(prompt, /Disclose missing inspection and offer capture instructions as optional/);
        assert.match(prompt, /supersedes visual-review handoffs/);
        assert.match(prompt, /no additional operator visual decision is required/);
        assert.match(prompt, /visualReview.required: true even when pre-approved/);
        assert.match(prompt, /preserve sandbox restrictions/);
        if (job?.kind === "resolve_conflicts") assert.match(prompt, /does not by itself cover UI changed during conflict resolution/);
        if (job?.kind === "resolve_conflicts" && job.phase === "validate") assert.match(prompt, /checkpoint candidate: db98771b/);
        if (job?.kind === "fix_checks") assert.match(prompt, /Merge-check fix of candidate f1x0c4e. A decision for the original task candidate does not by itself cover UI changed by this fix/);
      }
    }
    const resolution = userPrompt(task, jobs[2]);
    assert.ok(resolution.indexOf("## Current visual-decision context") > resolution.indexOf(task.report.summary));
  } finally { store.close(); }
});

test("visual handoffs retain pending decisions after pre-approval withdrawal and scope recorded decisions", () => {
  const store = new Store(":memory:");
  try {
    const task = store.createTask({ kind: "maintenance", title: "UI", brief: "Change UI", repoId: null, autonomy: "propose" });
    for (const status of ["pending", "inspected", "waived", "not_required"] as const) {
      const visualReview: VisualReview = { status, commit: "old-candidate", tree: "old-tree", branchCommit: "old-branch",
        note: "Original view", decidedAt: status === "pending" ? null : "2026-11-01" };
      for (const prompt of prompts({ ...task, preApprovedAt: null, visualReview })) {
        assert.match(prompt, /Operator pre-approval: none/);
        assert.match(prompt, /If UI work has no covering candidate decision, include the required operator checklist/);
        assert.ok(prompt.includes(JSON.stringify(visualReview)));
        assert.match(prompt, /do not infer coverage from an old inspected, waived, or not_required status/);
        assert.match(prompt, /do not grant a waiver yourself/);
      }
    }
    for (const prompt of [systemPrompt(task, null), resumePrompt({ task })]) {
      assert.match(prompt, /only when a visual decision remains outstanding and the task is not pre-approved/);
      assert.match(prompt, /A waiver does not mean inspection occurred/);
      assert.match(prompt, /defer capture directly without attempting it/);
      assert.match(prompt, /npm run build -w web && npm run screenshot/);
      assert.match(prompt, /Crane alone verifies decision coverage/);
    }
    assert.doesNotMatch(userPrompt({ ...task, autonomy: "observe" }), /Current visual-decision context/);
  } finally { store.close(); }
});

test("agent runs refresh visual authorization before resolver validation and transient retries", async () => {
  const store = new Store(":memory:");
  try {
    const task = store.createTask({ kind: "maintenance", title: "UI", brief: "", repoId: null, autonomy: "propose" });
    store.upsertAgent({ id: "review-agent", name: "Reviewer", driver: "test" });
    assert.equal(store.setPreApproval(task.id, true), true);
    const preApprovedAt = store.getTask(task.id)!.preApprovedAt;
    const review: VisualReview = { status: "pending", commit: "new-candidate", tree: "new-tree", note: "Changed UI", decidedAt: null };
    let attempts = 0;
    const driver: AgentDriver = { name: "test", label: "Test", available: async () => true, run: async (ctx) => {
      attempts++;
      if (attempts === 1) {
        assert.ok(resumePrompt(ctx).includes(`Operator pre-approval: ${preApprovedAt}`));
        assert.equal(store.setPreApproval(task.id, false), true);
        store.updateTask(task.id, { visualReview: review });
        throw new AgentRunError("API Error: 503", { transient: true, sessionId: "retry" });
      }
      assert.equal(ctx.resumeSession, "retry");
      assert.match(resumePrompt(ctx), /Operator pre-approval: none/);
      assert.ok(userPrompt(ctx.task, ctx.job).includes(JSON.stringify(review)));
      return { report: { summary: "Done", findings: [], changedFiles: [] } };
    } };
    await runAgent({ store, maxTurns: 0, retryDelayMs: 1 }, "review-agent", driver, {
      task, repo: null, cwd: "/unused", signal: new AbortController().signal, emit: () => {},
      job: { kind: "resolve_conflicts", phase: "validate", checkpoint: "new-candidate", base: "main", files: [] },
    });
    assert.equal(attempts, 2);
  } finally { store.close(); }
});
