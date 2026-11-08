import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardContext } from "@crane/agent-policy";
import { encodeGuardContext, GUARD_DENY_PREFIX } from "../packages/agent-drivers/src/command-guard-protocol.js";
import { guardHookPath } from "../packages/agent-drivers/src/claude-guard.js";
import { specifiers } from "./support/imports.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const driverSrc = join(root, "packages", "agent-drivers", "src");
const hook = join(root, "packages", "agent-drivers", "dist", "command-guard-hook.js");
const modes = ["listed", "most", "auto"] as const;

const context: GuardContext = {
  access: "listed", profile: "worktree", worktree: "/work/task", checkout: "/repos/app",
  defaultBranch: "main", craneHome: "/factory", home: "/home/operator", allowed: [],
};

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
  decision: { permissionDecision: string; permissionDecisionReason: string } | null;
}

function runHook(args: string[], stdin: string): HookRun {
  const out = spawnSync(process.execPath, [hook, ...args], { input: stdin, encoding: "utf8", timeout: 20_000 });
  const parsed = out.stdout.trim() ? JSON.parse(out.stdout) : null;
  assert.ok(parsed === null || parsed.hookSpecificOutput?.hookEventName === "PreToolUse", out.stdout);
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, decision: parsed?.hookSpecificOutput ?? null };
}

function hookInput(tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "s-1", transcript_path: "/tmp/t.jsonl", cwd: "/work/task", permission_mode: "acceptEdits",
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "toolu_1",
  });
}

function call(command: string, overrides: Partial<GuardContext> = {}): HookRun {
  return runHook([encodeGuardContext({ ...context, ...overrides })], hookInput("Bash", { command }));
}

test("hook: the package build emits the hook, and driver sources resolve the compiled file", () => {
  assert.ok(existsSync(hook), "npm run build:packages compiles dist/command-guard-hook.js");
  assert.equal(guardHookPath(), hook, "tests that load src/ still point Claude Code at the build");
});

test("hook: hard categories are denied in every mode, with the guard's marker", () => {
  for (const access of modes) {
    for (const command of ["git push origin HEAD", "npm run crane -- approve t-1", "crane approve t-1", "sudo rm -rf /", "echo x > /etc/hosts"]) {
      const run = call(command, { access });
      assert.equal(run.status, 0, `${access}: ${command}: ${run.stderr}`);
      assert.equal(run.decision?.permissionDecision, "deny", `${access}: ${command}`);
      assert.ok(run.decision!.permissionDecisionReason.startsWith(`${GUARD_DENY_PREFIX} `), run.decision!.permissionDecisionReason);
      assert.equal(run.stderr, "crane-guard deny toolu_1\n", "the liveness line names the call");
    }
  }
});

test("hook: most commands allows what the classifier allows, beyond the old allowlist", () => {
  for (const command of ['python3 -c "print(1)"', "cargo build --release", "find . -name '*.ts' | xargs wc -l", "cd sub && make"]) {
    const run = call(command, { access: "most" });
    assert.equal(run.decision?.permissionDecision, "allow", command);
    assert.equal(run.stderr, "crane-guard allow toolu_1\n");
  }
  const publish = call("npm publish", { access: "most" });
  assert.equal(publish.decision?.permissionDecision, "deny");
  assert.match(publish.decision!.permissionDecisionReason, /requires an operator rule.*allow it for this repo with: Bash\(npm publish:\*\)/);
  assert.equal(call("npm publish", { access: "most", allowed: ["Bash(npm publish:*)"] }).decision?.permissionDecision, "allow");
});

test("hook: listed and auto never answer allow, leaving the rest to Claude Code", () => {
  for (const access of ["listed", "auto"] as const) {
    for (const command of ['python3 -c "print(1)"', "ls", "npm test", "cargo build", "npm publish", "ssh host"]) {
      const run = call(command, { access, allowed: ["Bash(npm publish:*)", "Bash(ssh:*)"] });
      assert.notEqual(run.decision?.permissionDecision, "allow", `${access}: ${command}`);
      if (run.decision) continue;
      assert.equal(run.stdout, "", "no decision means no output at all");
      assert.equal(run.stderr, "crane-guard pass toolu_1\n");
    }
  }
  const outward = call("npm publish", { access: "auto" });
  assert.equal(outward.decision?.permissionDecision, "deny", "auto mode still denies outward commands without a rule");
});

test("hook: inspect permits only positive read-only matches, including auto repos without auto mode", () => {
  for (const access of ["most", "auto"] as const) {
    for (const command of ["find src -name '*.ts'", "sed -n 1,40p x", "git log --oneline | head -20"]) {
      const run = call(command, { profile: "inspect", access });
      assert.equal(run.status, 0);
      assert.equal(run.decision?.permissionDecision, "allow", `${access}: ${command}`);
      assert.match(run.decision!.permissionDecisionReason, /read-only inspection list/);
    }
    for (const command of ["find . -delete", "sort -o f x", "node -e 'console.log(1)'"]) {
      assert.notEqual(call(command, { profile: "inspect", access }).decision?.permissionDecision, "allow", command);
    }
  }
  assert.equal(call("find src -name '*.ts'", { profile: "inspect", access: "listed" }).decision, null);
});

test("hook: file writes outside the worktree or to agent settings are denied, others left alone", () => {
  for (const access of modes) {
    const ctx = [encodeGuardContext({ ...context, access })];
    assert.equal(runHook(ctx, hookInput("Write", { file_path: "/etc/passwd", content: "x" })).decision?.permissionDecision, "deny");
    assert.equal(runHook(ctx, hookInput("Edit", { file_path: "/work/task/.claude/settings.json" })).decision?.permissionDecision, "deny");
    assert.equal(runHook(ctx, hookInput("NotebookEdit", { notebook_path: "../other/n.ipynb" })).decision?.permissionDecision, "deny");
    const inside = runHook(ctx, hookInput("Write", { file_path: "/work/task/src/a.ts", content: "x" }));
    assert.equal(inside.decision, null, `${access}: acceptEdits decides writes inside the worktree`);
    assert.equal(inside.status, 0);
  }
});

test("hook: job runs refuse the Git commands Crane runs itself", () => {
  const run = call("git commit -m done", { profile: "job", access: "most" });
  assert.equal(run.decision?.permissionDecision, "deny");
  assert.equal(call("git commit -m done", { access: "most" }).decision?.permissionDecision, "allow");
});

test("hook: unreadable context or input refuses the call with exit 2", () => {
  const good = encodeGuardContext(context);
  const bash = hookInput("Bash", { command: "ls" });
  const bad = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const cases: [string, string[], string][] = [
    ["no context", [], bash],
    ["not base64url", ["!!not-base64"], bash],
    ["not JSON", [Buffer.from("{").toString("base64url")], bash],
    ["unknown access", [bad({ ...context, access: "everything" })], bash],
    ["relative worktree", [bad({ ...context, worktree: "work/task" })], bash],
    ["no default branch", [bad({ ...context, defaultBranch: "" })], bash],
    ["allowed isn't a list", [bad({ ...context, allowed: "Bash(*)" })], bash],
    ["input not JSON", [good], "not json"],
    ["empty input", [good], ""],
    ["input names no tool", [good], JSON.stringify({ tool_input: { command: "ls" } })],
    ["input is a list", [good], "[]"],
    ["tool input missing", [good], JSON.stringify({ tool_name: "Bash", tool_input: null })],
    ["another hook event", [good], JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } })],
  ];
  for (const [label, args, stdin] of cases) {
    for (const access of ["most", "listed"]) {
      const withAccess = args[0] === good ? [encodeGuardContext({ ...context, access: access as GuardContext["access"] })] : args;
      const run = runHook(withAccess, stdin);
      assert.equal(run.status, 2, `${label}: ${run.stderr}`);
      assert.equal(run.stdout, "", `${label}: never a JSON decision, so never an allow`);
      assert.ok(run.stderr.includes(`${GUARD_DENY_PREFIX} the guard couldn't check this call`), `${label}: ${run.stderr}`);
    }
  }
});

test("hook: imports only Node, the classifier and its protocol, and stays out of the package API", () => {
  const hookImports = specifiers(join(driverSrc, "command-guard-hook.ts"));
  assert.deepEqual(hookImports.filter((spec) => !spec.startsWith("node:")).sort(), ["./command-guard-protocol.js", "@crane/agent-policy"]);
  assert.deepEqual(specifiers(join(driverSrc, "command-guard-protocol.ts")), ["@crane/agent-policy"]);
  assert.doesNotMatch(readFileSync(join(driverSrc, "index.ts"), "utf8"), /command-guard|claude-guard/);
});
