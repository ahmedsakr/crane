import type { AgentDriver, RunContext, RunResult } from "@crane/agent-protocol";
import { cliAnswers } from "./cli.js";
import { resumePrompt, systemPrompt, userPrompt } from "./prompts.js";
import { ALWAYS_DENIED, type GuardContext } from "@crane/agent-policy";
import type { Autonomy } from "@crane/contracts";
import { runAgentProcess, runResumingSession } from "./agent-process.js";
import { ClaudeStream } from "./claude-stream.js";
import { checkHandleCommand, claudeSettings, guardForRun } from "./claude-guard.js";
import { craneCliCommand, craneCliRules } from "./crane-cli.js";

export { describeBlocked, usageFromResult } from "./claude-stream.js";

const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebSearch",
  "WebFetch",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(ls:*)",
  "Bash(wc:*)",
  // Agents pipe output through these constantly (`npm test 2>&1 | tail -20`);
  // every command in a pipeline must be allowed or the whole call is refused.
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(pwd:*)",
];

const WRITE_TOOLS = [
  ...READ_ONLY_TOOLS,
  "Edit",
  "Write",
  "MultiEdit",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git mv:*)",
  "Bash(git rm:*)",
  "Bash(npm test:*)",
  "Bash(npm run:*)",
  "Bash(npm install:*)",
  "Bash(npm ci:*)",
  "Bash(pnpm install:*)",
  "Bash(yarn install:*)",
  "Bash(npx tsc:*)",
  "Bash(node:*)",
  "Bash(python3 -m pytest:*)",
  "Bash(pytest:*)",
  "Bash(make:*)",
  "Bash(cargo test:*)",
  "Bash(go test:*)",
];

/** Rules the operator chose: `CRANE_ALLOWED_TOOLS` for every repo, then this repo's. */
function operatorRules(repoAllowed: string[] = []): string[] {
  const extra = process.env.CRANE_ALLOWED_TOOLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return [...new Set([...extra, ...repoAllowed])];
}

/**
 * What an agent may use. `repoAllowed` is what the operator allowed for the
 * repo (see OperatorActions.allowTool). Claude Code applies deny rules before
 * allow rules, so nothing allowed here can override ALWAYS_DENIED.
 *
 * Write runs and most/auto investigate-only runs also have Crane's command guard
 * (`classifyToolCall`) as a PreToolUse hook, in every command access mode. It
 * denies hard-dangerous calls (shared Git state, operator actions, writes
 * outside the worktree, credentials) even when this list would allow them.
 * In "Most commands" its allow widens this list to almost any command; deny
 * rules still win over that allow. In auto mode the list is unchanged and the
 * worktree guard never allows, so Claude Code's classifier reviews the rest.
 * Investigate-only runs keep this read-only baseline; their guard approves
 * only its positive list of inspection commands, without auto mode. A guard
 * that fails to answer leaves the call to this list (and, in auto mode, the
 * classifier). See docs/command-guard.md.
 *
 * `craneCli` adds narrow rules for the factory CLI's read-only `tasks` and
 * `show` commands (`crane-cli.ts`), in every mode, so agents can read task logs.
 */
export function toolsFor(autonomy: Autonomy, repoAllowed: string[] = [], craneCli?: string): { allowed: string[]; denied: string[] } {
  const base = autonomy === "observe" ? READ_ONLY_TOOLS : WRITE_TOOLS;
  const denied = autonomy === "observe" ? ["Edit", "Write", "MultiEdit", "NotebookEdit", ...ALWAYS_DENIED] : ALWAYS_DENIED;
  const cli = craneCliRules(craneCliCommand(craneCli));
  return { allowed: [...new Set([...base, ...cli, ...operatorRules(repoAllowed)])], denied };
}

/**
 * Auto mode only for a write-capable guarded run in an `auto` repo.
 * Its classifier reviews what ALWAYS_DENIED, the guard and the
 * narrow allow rules leave undecided; Claude Code suspends broad interpreter
 * rules such as `Bash(node:*)` on its own. Never bypassPermissions.
 */
export function permissionMode(autonomy: Autonomy, guard?: GuardContext): "default" | "manual" | "acceptEdits" | "auto" {
  if (autonomy === "observe") return guard ? "manual" : "default";
  if (guard?.access === "auto") return "auto";
  return "acceptEdits";
}

/** Investigate-only runs may not write, so they don't get the check handle, which records into the worktree. */
function checkHandleFor(autonomy: Autonomy): string | undefined {
  return autonomy === "observe" ? undefined : checkHandleCommand() ?? undefined;
}

export function claudeArgs(
  ctx: RunContext, autonomy: Autonomy, tools: { allowed: string[]; denied: string[] }, resume?: string, guard?: GuardContext,
): string[] {
  const settings = guard ? claudeSettings(guard) : null;
  const mode = permissionMode(autonomy, guard);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    systemPrompt(ctx.task, ctx.repo, ctx.job, {
      checks: ctx.checks, commandAccess: guard?.access, checkHandle: checkHandleFor(autonomy), craneCli: craneCliCommand(ctx.craneCli) ?? undefined,
    }),
    "--permission-mode",
    mode,
    "--allowedTools",
    tools.allowed.join(","),
    "--disallowedTools",
    tools.denied.join(","),
  ];
  // Nobody can answer a prompt, so "would prompt" is a recognizable denial, including auto mode's pause.
  if (mode === "auto") args.push("--permission-prompts", "none");
  // Hook events let the stream check that the guard answered for each command.
  if (settings) args.push("--settings", JSON.stringify(settings), "--include-hook-events");
  if (ctx.maxTurns) args.push("--max-turns", String(ctx.maxTurns));
  if (resume) args.push("--resume", resume);
  const model = ctx.model || process.env.CRANE_MODEL;
  if (model) args.push("--model", model);
  if (ctx.effort) args.push("--effort", ctx.effort);
  return args;
}

/** Don't let a parent Claude Code session's environment leak into the agent. */
function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/**
 * Runs tasks through Claude Code in headless mode (`claude -p`), which uses
 * whatever auth the local `claude` CLI already has, a Claude subscription or an
 * API key. Each run streams JSON events that we translate into task events.
 */
export class ClaudeCodeDriver implements AgentDriver {
  readonly name = "claude-code";
  readonly label = "Claude Code";
  constructor(private bin = process.env.CRANE_CLAUDE_BIN ?? "claude") {}

  available(): Promise<boolean> {
    return cliAnswers(this.bin);
  }

  run(ctx: RunContext): Promise<RunResult> {
    return runResumingSession(ctx, (resume) => this.runOnce(ctx, resume));
  }

  private runOnce(ctx: RunContext, resume?: string): Promise<RunResult> {
    // Resolving conflicts means editing files, so it gets write tools. ALWAYS_DENIED
    // still applies: Crane, not the agent, commits the merge and pushes it.
    const autonomy: Autonomy = ctx.job ? "propose" : ctx.task.autonomy;
    const tools = toolsFor(autonomy, ctx.allowedTools, ctx.craneCli);
    const guard = guardForRun(ctx, operatorRules(ctx.allowedTools));
    return runAgentProcess({
      bin: this.bin,
      label: this.label,
      args: claudeArgs(ctx, autonomy, tools, resume, guard),
      env: claudeEnv(),
      prompt: resume ? resumePrompt(ctx, { commandAccess: guard?.access, checkHandle: checkHandleFor(autonomy) }) : userPrompt(ctx.task, ctx.job, ctx),
      resume,
      stream: new ClaudeStream(ctx, tools, resume, guard),
      ctx,
    });
  }
}
