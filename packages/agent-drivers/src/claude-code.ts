import type { AgentDriver, RunContext, RunResult } from "@crane/agent-protocol";
import { cliAnswers } from "./cli.js";
import { resumePrompt, systemPrompt, userPrompt } from "./prompts.js";
import { ALWAYS_DENIED } from "@crane/agent-policy";
import type { Autonomy } from "@crane/contracts";
import { runAgentProcess, runResumingSession } from "./agent-process.js";
import { ClaudeStream } from "./claude-stream.js";
import { claudeSettings, guardContext } from "./claude-guard.js";

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
 * Every run except investigate-only also has Crane's command guard
 * (`classifyToolCall`) as a PreToolUse hook, in every command access mode. It
 * denies hard-dangerous calls (shared Git state, operator actions, writes
 * outside the worktree, credentials) even when this list would allow them.
 * In "Most commands" its allow widens this list to almost any command; deny
 * rules still win over that allow. A guard that fails to answer leaves the
 * call to this list. See docs/command-guard.md.
 */
export function toolsFor(autonomy: Autonomy, repoAllowed: string[] = []): { allowed: string[]; denied: string[] } {
  const base = autonomy === "observe" ? READ_ONLY_TOOLS : WRITE_TOOLS;
  const denied = autonomy === "observe" ? ["Edit", "Write", "MultiEdit", "NotebookEdit", ...ALWAYS_DENIED] : ALWAYS_DENIED;
  return { allowed: [...new Set([...base, ...operatorRules(repoAllowed)])], denied };
}

/** Inline `--settings` for the run, or null for investigate-only runs, which get no guard. */
function runSettings(ctx: RunContext, autonomy: Autonomy): Record<string, unknown> | null {
  if (autonomy === "observe") return null;
  return claudeSettings(guardContext(ctx, operatorRules(ctx.allowedTools)));
}

function claudeArgs(ctx: RunContext, autonomy: Autonomy, tools: { allowed: string[]; denied: string[] }, resume?: string): string[] {
  const settings = runSettings(ctx, autonomy);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    systemPrompt(ctx.task, ctx.repo, ctx.job, { checks: ctx.checks }),
    "--permission-mode",
    autonomy === "observe" ? "default" : "acceptEdits",
    "--allowedTools",
    tools.allowed.join(","),
    "--disallowedTools",
    tools.denied.join(","),
  ];
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
    const tools = toolsFor(autonomy, ctx.allowedTools);
    return runAgentProcess({
      bin: this.bin,
      label: this.label,
      args: claudeArgs(ctx, autonomy, tools, resume),
      env: claudeEnv(),
      prompt: resume ? resumePrompt(ctx) : userPrompt(ctx.task, ctx.job, ctx),
      resume,
      stream: new ClaudeStream(ctx, tools, resume, autonomy !== "observe"),
      ctx,
    });
  }
}
