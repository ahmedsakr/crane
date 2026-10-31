import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentDriver, RunContext, RunResult } from "./driver.js";
import { resumePrompt, systemPrompt, userPrompt } from "./prompts.js";
import { parseReport } from "./report.js";
import type { Autonomy, RunUsage } from "../core/types.js";

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

/**
 * Never allowed, regardless of autonomy. Agents never ship code: when the
 * operator approves a merge, Crane's own code (src/factory/merge.ts) does it.
 */
const ALWAYS_DENIED = ["Bash(git push:*)", "Bash(git checkout main:*)", "Bash(git merge:*)", "Bash(rm -rf:*)"];

function toolsFor(autonomy: Autonomy): { allowed: string[]; denied: string[] } {
  const extra = process.env.CRANE_ALLOWED_TOOLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (autonomy === "observe") {
    return { allowed: [...READ_ONLY_TOOLS, ...extra], denied: ["Edit", "Write", "MultiEdit", "NotebookEdit", ...ALWAYS_DENIED] };
  }
  return { allowed: [...WRITE_TOOLS, ...extra], denied: ALWAYS_DENIED };
}

/** Summarise a tool call in a few words for the activity feed. */
function describeTool(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Read":
      return `Read ${s(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Edited ${s(input.file_path)}`;
    case "Write":
      return `Wrote ${s(input.file_path)}`;
    case "Grep":
      return `Searched for “${s(input.pattern)}”`;
    case "Glob":
      return `Listed ${s(input.pattern)}`;
    case "Bash":
      return `Ran ${s(input.command).split("\n")[0]?.slice(0, 120)}`;
    case "WebSearch":
      return `Searched the web for “${s(input.query)}”`;
    case "WebFetch":
      return `Read ${s(input.url)}`;
    case "TodoWrite":
      return "Updated its plan";
    case "Task":
      return `Delegated: ${s(input.description)}`;
    default:
      return name;
  }
}

/** Claude Code exited before it got going again on an earlier session. */
class SessionNotResumed extends Error {}

/**
 * What a run used, from the `result` message that ends Claude Code's stream.
 * `modelUsage` breaks it down per model (it includes any subagents), so prefer
 * it; older versions only send the main loop's `usage`.
 */
export function usageFromResult(msg: Record<string, any>, initModel: string | null = null): RunUsage {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const perModel = Object.entries((msg.modelUsage ?? {}) as Record<string, Record<string, unknown>>);
  const sum = (key: string) => perModel.reduce((s, [, u]) => s + n(u[key]), 0);
  const top = perModel.sort(([, a], [, b]) => n(b.costUSD) - n(a.costUSD))[0]?.[0];
  return {
    costUsd: n(msg.total_cost_usd),
    inputTokens: perModel.length ? sum("inputTokens") : n(msg.usage?.input_tokens),
    outputTokens: perModel.length ? sum("outputTokens") : n(msg.usage?.output_tokens),
    cacheReadTokens: perModel.length ? sum("cacheReadInputTokens") : n(msg.usage?.cache_read_input_tokens),
    cacheWriteTokens: perModel.length ? sum("cacheCreationInputTokens") : n(msg.usage?.cache_creation_input_tokens),
    turns: n(msg.num_turns),
    model: top ?? initModel,
  };
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
      // Its history is gone, or Claude Code won't load it. The worktree still has the work so far.
      ctx.emit("note", "Couldn't pick up the agent's earlier session, so it's starting a new one on the work so far");
      return this.runOnce(ctx);
    }
  }

  private runOnce(ctx: RunContext, resume?: string): Promise<RunResult> {
    const { task, repo, cwd, emit, signal, job } = ctx;
    // Resolving conflicts means editing files, so it gets write tools. ALWAYS_DENIED
    // still applies: Crane, not the agent, commits the merge and pushes it.
    const autonomy: Autonomy = job ? "propose" : task.autonomy;
    const { allowed, denied } = toolsFor(autonomy);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      systemPrompt(task, repo, job),
      "--permission-mode",
      autonomy === "observe" ? "default" : "acceptEdits",
      "--allowedTools",
      allowed.join(","),
      "--disallowedTools",
      denied.join(","),
    ];
    if (resume) args.push("--resume", resume);
    if (process.env.CRANE_MODEL) args.push("--model", process.env.CRANE_MODEL);

    // Don't let a parent Claude Code session's environment leak into the agent.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let finalText = "";
      let lastText = "";
      let model: string | null = null;
      let errored: string | null = null;
      let stderr = "";
      let started = false;

      const onAbort = () => {
        child.kill("SIGTERM");
        // The factory waits a few seconds for agents to stop before it exits. Don't outlive that.
        setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 3000).unref();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdin.end(resume ? resumePrompt() : userPrompt(task, job));
      child.stderr.on("data", (d) => {
        stderr = (stderr + String(d)).slice(-4000);
      });

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          started = true;
          model = typeof msg.model === "string" ? msg.model : null;
          if (typeof msg.session_id === "string") ctx.onSession?.(msg.session_id);
          const verb = resume ? "resumed" : "started";
          emit("note", `Agent session ${verb}${msg.model ? ` on ${msg.model}` : ""}`, { sessionId: msg.session_id });
        } else if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              lastText = block.text;
              const visible = block.text.split("```crane-report")[0]!.trim();
              if (visible) emit("note", visible.slice(0, 1200));
            } else if (block.type === "tool_use") {
              emit("tool", describeTool(block.name, block.input ?? {}), { tool: block.name });
            }
          }
        } else if (msg.type === "result") {
          // Reported before we decide whether the run succeeded: a failed run still cost this.
          ctx.onUsage?.(usageFromResult(msg, model));
          finalText = typeof msg.result === "string" ? msg.result : lastText;
          if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
            errored = typeof msg.result === "string" ? msg.result : `Agent stopped: ${msg.subtype}`;
          }
        }
      });

      child.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error(`Could not start Claude Code (${this.bin}): ${err.message}`));
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return reject(new Error("Cancelled by operator"));
        if (resume && !started) {
          return reject(new SessionNotResumed(errored ?? (stderr.trim().slice(-500) || `exit code ${code}`)));
        }
        if (errored) return reject(new Error(errored));
        if (code !== 0 && !finalText) {
          return reject(new Error(`Claude Code exited with code ${code}. ${stderr.trim().slice(-500)}`));
        }
        resolve({ report: parseReport(finalText || lastText) });
      });
    });
  }
}
