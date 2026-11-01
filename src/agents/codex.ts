import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { relative, isAbsolute } from "node:path";
import type { AgentDriver, RunContext, RunResult } from "./driver.js";
import { resumePrompt, systemPrompt, userPrompt } from "./prompts.js";
import { parseReport } from "./report.js";
import type { RunUsage } from "../core/types.js";
import { codexCost, combinedCost } from "./codex-pricing.js";

/** Codex exited before it got going again on an earlier session. */
class SessionNotResumed extends Error {}

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

/** `bash -lc 'npm test'` → `npm test`. Codex wraps every command in a login shell. */
export function unwrapShell(command: unknown): string {
  const raw = Array.isArray(command) ? command.map(String).join(" ") : typeof command === "string" ? command : "";
  const m = raw.match(/^(?:\S*\/)?(?:ba|z)?sh -l?c\s+(['"])([\s\S]*)\1\s*$/);
  return (m ? m[2]! : raw).trim();
}

/** What Codex used, from its `turn.completed` usage. Its input count includes cached tokens. */
export function usageFromTurn(usage: Record<string, unknown> | undefined, model: string | null): RunUsage {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  const input = n(usage?.input_tokens);
  const cached = Math.min(input, n(usage?.cached_input_tokens));
  const output = n(usage?.output_tokens);
  const valid = [usage?.input_tokens, usage?.cached_input_tokens, usage?.output_tokens]
    .every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) && n(usage?.cached_input_tokens) <= input;
  const cost = valid ? codexCost(model, input - cached, cached, output) : null;
  return {
    costUsd: cost ?? 0,
    costStatus: cost === null ? "unknown" : "estimated",
    inputTokens: input - cached,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    turns: 1,
    model,
  };
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
    return new Promise((resolve) => {
      const p = spawn(this.bin, ["--version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    });
  }

  async run(ctx: RunContext): Promise<RunResult> {
    if (!ctx.resumeSession) return this.runOnce(ctx);
    try {
      return await this.runOnce(ctx, ctx.resumeSession);
    } catch (err) {
      if (!(err instanceof SessionNotResumed) || ctx.signal.aborted) throw err;
      ctx.emit("note", "Couldn't pick up the agent's earlier session, so it's starting a new one on the work so far");
      return this.runOnce(ctx);
    }
  }

  private runOnce(ctx: RunContext, resume?: string): Promise<RunResult> {
    const { task, repo, cwd, emit, signal, job } = ctx;
    // Resolving conflicts means editing files, so it gets a writable sandbox.
    const readOnly = !job && task.autonomy === "observe";
    const model = ctx.model || this.model || null;
    const args = codexArgs({ cwd, readOnly, resume, model: model ?? undefined, effort: ctx.effort });
    // Codex has no separate system prompt flag, so Crane's brief leads the first message.
    const prompt = resume
      ? resumePrompt()
      : `${systemPrompt(task, repo, job, { agentCommits: false, sandboxed: true, checks: ctx.checks })}\n\n---\n\n${userPrompt(task, job)}`;
    const rel = (p: unknown) => {
      const s = typeof p === "string" ? p : "";
      return isAbsolute(s) && s.startsWith(cwd) ? relative(cwd, s) || s : s;
    };

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let lastText = "";
      let started = false;
      let turns = 0;
      let usage: RunUsage | null = null;
      let failed: string | null = null; // the turn failed
      let errored: string | null = null; // the last stream error, which may have been recovered from
      let stderr = "";

      const onAbort = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 3000).unref();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdin.on("error", () => {}); // it exited before reading the prompt; `close` reports why
      child.stdin.end(prompt);
      child.stderr.on("data", (d) => {
        stderr = (stderr + String(d)).slice(-4000);
      });

      const onItem = (phase: "started" | "completed", item: Record<string, any>) => {
        switch (item.type) {
          case "agent_message":
            if (phase !== "completed" || typeof item.text !== "string" || !item.text.trim()) return;
            lastText = item.text;
            {
              const visible = item.text.split("```crane-report")[0]!.trim();
              if (visible) emit("note", visible.slice(0, 1200));
            }
            return;
          case "command_execution":
            if (phase === "started") emit("tool", `Ran ${unwrapShell(item.command).split("\n")[0]?.slice(0, 120)}`, { tool: "shell" });
            return;
          case "file_change":
            if (phase !== "completed") return;
            for (const c of (item.changes ?? []) as { path?: string; kind?: string }[]) {
              const verb = c.kind === "add" ? "Wrote" : c.kind === "delete" ? "Deleted" : "Edited";
              emit("tool", `${verb} ${rel(c.path)}`, { tool: "file_change" });
            }
            return;
          case "web_search":
            if (phase === "started") emit("tool", `Searched the web for “${item.query ?? ""}”`, { tool: "web_search" });
            return;
          case "mcp_tool_call":
            if (phase === "started") emit("tool", `${item.server ?? "mcp"}: ${item.tool ?? "tool"}`, { tool: "mcp" });
            return;
          case "todo_list":
            if (phase === "started") emit("tool", "Updated its plan", { tool: "todo_list" });
            return;
          case "error":
            if (typeof item.message === "string") emit("note", item.message.slice(0, 600));
            return;
        }
      };

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        switch (msg.type) {
          case "thread.started": {
            started = true;
            if (typeof msg.thread_id === "string") ctx.onSession?.(msg.thread_id);
            const verb = resume ? "resumed" : "started";
            const tuned = [model, ctx.effort ? `${ctx.effort} effort` : null].filter(Boolean).join(", ");
            emit("note", `Agent session ${verb} on Codex${tuned ? ` (${tuned})` : ""}`, { sessionId: msg.thread_id });
            return;
          }
          case "item.started":
          case "item.completed":
            if (msg.item && typeof msg.item === "object") onItem(msg.type === "item.started" ? "started" : "completed", msg.item);
            return;
          case "turn.completed": {
            turns++;
            const u = usageFromTurn(msg.usage, model);
            usage = !usage
              ? u
              : {
                  ...usage,
                  ...combinedCost(usage, u),
                  inputTokens: usage.inputTokens + u.inputTokens,
                  outputTokens: usage.outputTokens + u.outputTokens,
                  cacheReadTokens: usage.cacheReadTokens + u.cacheReadTokens,
                  turns,
                };
            return;
          }
          case "turn.failed":
            failed = String(msg.error?.message ?? "The agent stopped with an error");
            return;
          case "error":
            // Codex also sends these for retries it recovers from; only the last one matters if the run fails.
            if (typeof msg.message === "string") errored = msg.message;
            return;
        }
      });

      child.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error(`Could not start Codex (${this.bin}): ${err.message}`));
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        // Reported before we decide whether the run succeeded: a failed run still used tokens.
        if (usage) ctx.onUsage?.(usage);
        if (signal.aborted) return reject(new Error("Cancelled by operator"));
        if (resume && !started) {
          return reject(new SessionNotResumed(failed ?? errored ?? (stderr.trim().slice(-500) || `exit code ${code}`)));
        }
        if (failed) return reject(new Error(failed));
        // A turn that completed is a success, even if a recovered error came before it.
        if (turns === 0 && errored) return reject(new Error(errored));
        if (!started && !lastText) {
          const tail = stderr.trim().slice(-500);
          return reject(
            new Error(
              code === 0
                ? "Codex finished without sending any events Crane understands. Update Codex (npm i -g @openai/codex) and try again."
                : `Codex exited with code ${code}. ${tail}`,
            ),
          );
        }
        if (code !== 0 && !lastText) return reject(new Error(`Codex exited with code ${code}. ${stderr.trim().slice(-500)}`));
        resolve({ report: parseReport(lastText) });
      });
    });
  }
}
