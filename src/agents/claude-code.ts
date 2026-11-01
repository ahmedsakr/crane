import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  AgentRunError,
  isTransientFailure,
  parseReport,
  type AgentDriver,
  type RunContext,
  type RunResult,
} from "../agent-protocol/index.js";
import { resumePrompt, systemPrompt, userPrompt } from "./prompts.js";
import { ALWAYS_DENIED } from "./policy.js";
import { overlapsDenied, suggestRules } from "../core/permissions.js";
import type { Autonomy, BlockedCall, RunUsage } from "../core/types.js";

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
 * What an agent may use. `repoAllowed` is what the operator allowed for the
 * repo (see OperatorActions.allowTool). Claude Code applies deny rules before
 * allow rules, so nothing allowed here can override ALWAYS_DENIED.
 */
export function toolsFor(autonomy: Autonomy, repoAllowed: string[] = []): { allowed: string[]; denied: string[] } {
  const extra = process.env.CRANE_ALLOWED_TOOLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const base = autonomy === "observe" ? READ_ONLY_TOOLS : WRITE_TOOLS;
  const denied = autonomy === "observe" ? ["Edit", "Write", "MultiEdit", "NotebookEdit", ...ALWAYS_DENIED] : ALWAYS_DENIED;
  return { allowed: [...new Set([...base, ...extra, ...repoAllowed])], denied };
}

/** What the activity feed says about a refused call, and the rules that would have allowed it. */
export function describeBlocked(
  tool: string,
  input: Record<string, unknown>,
  tools: { allowed: string[]; denied: string[] },
): { message: string; data: BlockedCall } {
  const command = tool === "Bash" && typeof input.command === "string" ? input.command : undefined;
  let rules = suggestRules(tool, input, tools.allowed);
  // Refused on purpose: nothing to offer, and any rule we suggested would lose to the deny list anyway.
  if (rules.some((r) => overlapsDenied(r, tools.denied))) rules = [];
  const target = [input.file_path, input.path, input.url, input.pattern].find((v) => typeof v === "string") as string | undefined;
  const what = command ?? (target ? `${tool} ${target}` : tool);
  return {
    message: `Blocked: ${what.split("\n")[0]!.slice(0, 160)}`,
    data: { tool, ...(command ? { command: command.slice(0, 2000) } : {}), rules },
  };
}

/** Claude Code's wording when the permission system refuses a tool call. */
const DENIAL_TEXT = /Claude requested permissions? to |haven't granted it yet|^\s*Permission to (use|read|write|edit) .* has been denied/i;

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
    const tools = toolsFor(autonomy, ctx.allowedTools);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      systemPrompt(task, repo, job, { checks: ctx.checks }),
      "--permission-mode",
      autonomy === "observe" ? "default" : "acceptEdits",
      "--allowedTools",
      tools.allowed.join(","),
      "--disallowedTools",
      tools.denied.join(","),
    ];
    if (ctx.maxTurns) args.push("--max-turns", String(ctx.maxTurns));
    if (resume) args.push("--resume", resume);
    const model = ctx.model || process.env.CRANE_MODEL;
    if (model) args.push("--model", model);
    if (ctx.effort) args.push("--effort", ctx.effort);

    // Don't let a parent Claude Code session's environment leak into the agent.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let finalText = "";
      let lastText = "";
      let model: string | null = null;
      let sessionId: string | null = resume ?? null;
      let errored: string | null = null;
      let outOfTurns = false;
      let stderr = "";
      let started = false;
      // Tool calls by id, so a refusal can be reported with what was asked for.
      const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
      const reported = new Set<string>();
      const blocked = (id: string, name: string, input: Record<string, unknown>) => {
        if (reported.has(id)) return;
        reported.add(id);
        const { message, data } = describeBlocked(name, input, tools);
        emit("blocked", message, { ...data });
      };

      // A stuck agent may ignore SIGTERM, and the factory waits only a few seconds
      // for agents to stop before it exits. Don't hold a crew slot, or outlive that.
      const onAbort = () => {
        child.kill("SIGTERM");
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
          if (typeof msg.session_id === "string") {
            sessionId = msg.session_id;
            ctx.onSession?.(msg.session_id);
          }
          const verb = resume ? "resumed" : "started";
          const effort = ctx.effort ? `, ${ctx.effort} effort` : "";
          emit("note", `Agent session ${verb}${msg.model ? ` on ${msg.model}` : ""}${effort}`, { sessionId: msg.session_id });
        } else if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              lastText = block.text;
              const visible = block.text.split("```crane-report")[0]!.trim();
              if (visible) emit("note", visible.slice(0, 1200));
            } else if (block.type === "tool_use") {
              if (block.id) calls.set(block.id, { name: block.name, input: block.input ?? {} });
              emit("tool", describeTool(block.name, block.input ?? {}), { tool: block.name });
            }
          }
        } else if (msg.type === "user") {
          // Report refusals as they happen. The result's permission_denials, below, is the full record.
          for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
            if (block.type !== "tool_result" || !block.is_error || !block.tool_use_id) continue;
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            const call = calls.get(block.tool_use_id);
            if (call && DENIAL_TEXT.test(text)) blocked(block.tool_use_id, call.name, call.input);
          }
        } else if (msg.type === "result") {
          // Reported before we decide whether the run succeeded: a failed run still cost this.
          ctx.onUsage?.(usageFromResult(msg, model));
          if (typeof msg.session_id === "string") sessionId = msg.session_id;
          finalText = typeof msg.result === "string" ? msg.result : lastText;
          const denials: Record<string, any>[] = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
          denials.forEach((d, i) => {
            if (d?.tool_name) blocked(String(d.tool_use_id ?? `denial-${i}`), d.tool_name, d.tool_input ?? {});
          });
          if (msg.subtype === "error_max_turns") {
            outOfTurns = true;
            errored = `Stopped after ${msg.num_turns ?? ctx.maxTurns} turns, the most one run may take. Raise it with crane serve --max-turns or CRANE_MAX_TURNS`;
          } else if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
            const detail = Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join("; ") : null;
            errored = (typeof msg.result === "string" && msg.result) || detail || `Agent stopped: ${msg.subtype ?? "error"}`;
          }
        }
      });

      const fail = (message: string) =>
        reject(
          new AgentRunError(message, {
            transient: !outOfTurns && isTransientFailure(message),
            sessionId,
            ...(outOfTurns ? { limit: "turns" as const } : {}),
          }),
        );

      child.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error(`Could not start Claude Code (${this.bin}): ${err.message}`));
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return reject(new AgentRunError("Cancelled by operator", { sessionId }));
        if (resume && !started) {
          return reject(new SessionNotResumed(errored ?? (stderr.trim().slice(-500) || `exit code ${code}`)));
        }
        if (errored) return fail(errored);
        if (code !== 0 && !finalText) return fail(`Claude Code exited with code ${code}. ${stderr.trim().slice(-500)}`);
        resolve({ report: parseReport(finalText || lastText) });
      });
    });
  }
}
