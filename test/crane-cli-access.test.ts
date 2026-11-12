import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, type GuardContext } from "@crane/agent-policy";
import type { RunContext } from "@crane/agent-protocol";
import type { Task } from "@crane/contracts";
import { claudeArgs, toolsFor } from "../packages/agent-drivers/src/claude-code.js";
import { guardForRun } from "../packages/agent-drivers/src/claude-guard.js";
import { craneCliBrief, craneCliCommand, craneCliRules } from "../packages/agent-drivers/src/crane-cli.js";
import { systemPrompt } from "../packages/agent-drivers/src/prompts.js";

const CLI = "/opt/crane/bin/crane.js";
const task: Task = {
  id: "t-c", kind: "maintenance", title: "Why did t-x fail?", brief: "Read its log", repoId: "r-c", autonomy: "observe", status: "running",
  agentId: null, branch: null, worktree: null, sessionId: null, driver: null, model: null, effort: null, driverSettings: null,
  assignee: null, postmortemOf: null, preApprovedAt: null, prerequisites: [], prerequisitesWaivedAt: null, acceptance: [],
  acceptanceChecks: [], lookouts: [], report: null, costUsd: 0, createdAt: "", createdBy: null, scheduledAt: null,
  scheduleId: null, followUpOf: null, followUpFinding: null, startedAt: null, finishedAt: null,
};
const ctx: RunContext = {
  task, repo: { id: "r-c", name: "app", path: "/code/app", defaultBranch: "main", isFactory: false, addedAt: "" },
  cwd: "/code/app", signal: new AbortController().signal, emit: () => {}, craneHome: "/factory", craneCli: CLI,
};
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

test("crane cli: only an absolute path that needs no quoting becomes a command", () => {
  assert.equal(craneCliCommand(CLI), `node ${CLI}`);
  for (const path of [undefined, "", "bin/crane.js", "/my crane/bin/crane.js", "/x/$(id)/crane.js", "/x/'q'/crane.js"]) {
    assert.equal(craneCliCommand(path), null, String(path));
  }
  assert.deepEqual(craneCliRules(null), []);
  assert.equal(craneCliBrief(undefined), "");
});

test("crane cli: every autonomy gets narrow tasks and show rules, never broad Bash or node", () => {
  const rules = [`Bash(node ${CLI} tasks:*)`, `Bash(node ${CLI} show:*)`];
  for (const autonomy of ["observe", "propose", "act"] as const) {
    const allowed = toolsFor(autonomy, [], CLI).allowed;
    for (const rule of rules) assert.ok(allowed.includes(rule), `${autonomy} ${rule}`);
    assert.deepEqual(allowed.filter((rule) => rule.includes("crane.js")), rules, "no other CLI command");
  }
  assert.ok(!toolsFor("observe", [], CLI).allowed.some((rule) => ["Bash", "Bash(*)", "Bash(node:*)"].includes(rule)));
  assert.deepEqual(toolsFor("observe", [], "/my crane/bin/crane.js"), toolsFor("observe"), "an unsafe path adds nothing");
});

test("crane cli: the run's arguments carry the rules and the brief, and runs without a path keep their old prompt", () => {
  for (const commandAccess of ["listed", "most", "auto"] as const) {
    const run = { ...ctx, commandAccess };
    const tools = toolsFor("observe", [], run.craneCli);
    const args = claudeArgs(run, "observe", tools, undefined, guardForRun(run, []));
    assert.ok(after(args, "--allowedTools").split(",").includes(`Bash(node ${CLI} show:*)`), commandAccess);
    const prompt = after(args, "--append-system-prompt");
    assert.match(prompt, new RegExp(`node ${CLI} show <id> --events`));
    assert.match(prompt, new RegExp(`node ${CLI} tasks --all --json`));
    assert.match(prompt, /Only `tasks` and `show` are allowed/);
  }
  const without = { ...ctx, craneCli: undefined };
  const prompt = after(claudeArgs(without, "observe", toolsFor("observe")), "--append-system-prompt");
  assert.equal(prompt, systemPrompt(task, ctx.repo, undefined, {}));
  assert.doesNotMatch(prompt, /running factory's CLI/);
});

test("crane cli: the guard lets the read commands through and still refuses operator actions", () => {
  const base: GuardContext = {
    access: "most", profile: "worktree", worktree: "/factory/worktrees/t-c", checkout: "/code/app",
    defaultBranch: "main", craneHome: "/factory", home: "/home/operator", allowed: [],
  };
  for (const profile of ["worktree", "inspect"] as const) {
    const guard = { ...base, profile, worktree: profile === "inspect" ? "/code/app" : base.worktree };
    for (const command of [`node ${CLI} tasks --all --json`, `node ${CLI} show t-x --events`, `node ${CLI} show t-x --json | head -50`]) {
      assert.notEqual(classifyToolCall({ tool: "Bash", input: { command } }, guard).decision, "deny", `${profile}: ${command}`);
    }
    for (const command of [`node ${CLI} approve t-x`, `node ${CLI} retry t-x`, `node ${CLI} show t-x && node ${CLI} merge t-x`]) {
      const verdict = classifyToolCall({ tool: "Bash", input: { command } }, guard);
      assert.equal(verdict.decision, "deny", `${profile}: ${command}`);
      assert.equal(verdict.category, "operator-actions");
    }
  }
});
