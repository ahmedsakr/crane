import type { AgentDriver, RunContext, RunResult } from "@crane/agent-protocol";
import { cliAnswers } from "./cli.js";
import { resumePrompt, systemPrompt, userPrompt } from "./prompts.js";
import { runAgentProcess, runResumingSession } from "./agent-process.js";
import { CodexStream } from "./codex-stream.js";

export { unwrapShell, usageFromTurn } from "./codex-stream.js";

/**
 * The Codex flags that hold an agent to what its task allows. Codex has no
 * per-command deny list like Claude Code's, so Crane leans on its sandbox:
 *
 * - Investigate only runs `read-only`: it can read and run commands, never write.
 * - Everything else runs `workspace-write`: it can only write inside its own
 *   worktree. The worktree's git directory lives in the operator's repo, outside
 *   the sandbox, so it can't commit, move a branch, or merge; Crane commits what
 *   it leaves behind (`finalizeWorktree`). Network is off, so it can't push.
 *
 * The `-c` overrides beat anything in the operator's own ~/.codex/config.toml
 * that would loosen this (extra writable roots, network, approvals).
 */
export function codexArgs(opts: { cwd: string; readOnly: boolean; resume?: string; model?: string; effort?: string }): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--cd",
    opts.cwd,
    "--sandbox",
    opts.readOnly ? "read-only" : "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    "sandbox_workspace_write.writable_roots=[]",
  ];
  if (opts.model) args.push("--model", opts.model);
  // A bare word only: the value is parsed as TOML, and nothing else belongs in this override.
  if (opts.effort && /^[a-z]+$/.test(opts.effort)) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  // `-` reads the prompt from stdin, which keeps long briefs out of the process list.
  if (opts.resume) args.push("resume", opts.resume, "-");
  else args.push("-");
  return args;
}

/** Codex has no separate system prompt flag, so Crane's brief leads the first message. */
function codexPrompt(ctx: RunContext, resume?: string): string {
  if (resume) return resumePrompt(ctx);
  const brief = systemPrompt(ctx.task, ctx.repo, ctx.job, { agentCommits: false, sandboxed: true, checks: ctx.checks });
  return `${brief}\n\n---\n\n${userPrompt(ctx.task, ctx.job, ctx)}`;
}

/**
 * Runs tasks through OpenAI's Codex CLI in non-interactive mode (`codex exec`),
 * using whatever login the local `codex` already has. Each run streams JSON
 * events that we translate into task events.
 */
export class CodexDriver implements AgentDriver {
  readonly name = "codex";
  readonly label = "Codex";
  constructor(
    private bin = process.env.CRANE_CODEX_BIN ?? "codex",
    private model = process.env.CRANE_CODEX_MODEL || undefined,
  ) {}

  available(): Promise<boolean> {
    return cliAnswers(this.bin);
  }

  run(ctx: RunContext): Promise<RunResult> {
    return runResumingSession(ctx, (resume) => this.runOnce(ctx, resume));
  }

  private runOnce(ctx: RunContext, resume?: string): Promise<RunResult> {
    const { task, cwd, job } = ctx;
    // Resolving conflicts means editing files, so it gets a writable sandbox.
    const readOnly = !job && task.autonomy === "observe";
    const model = ctx.model || this.model || null;
    return runAgentProcess({
      bin: this.bin,
      label: this.label,
      args: codexArgs({ cwd, readOnly, resume, model: model ?? undefined, effort: ctx.effort }),
      env: process.env,
      prompt: codexPrompt(ctx, resume),
      resume,
      stream: new CodexStream(ctx, model, resume),
      ctx,
    });
  }
}
