import { isAbsolute, relative } from "node:path";
import { AgentRunError, addRunUsage, isTransientFailure, parseReport, type RunContext, type RunResult } from "@crane/agent-protocol";
import type { RunUsage } from "@crane/contracts";
import { cancelledRun, SessionNotResumed, stderrExcerpt, type AgentExit, type AgentStream } from "./agent-process.js";
import { emitAgentText } from "./cli.js";
import { codexCost } from "./codex-pricing.js";
import { commandMessage, CommandTracker } from "./command-evidence.js";

/** What a stream hears the run through. */
export type CodexStreamContext = Pick<RunContext, "cwd" | "emit" | "signal" | "effort" | "onSession" | "onUsage">;

type ItemPhase = "started" | "completed";

/** `bash -lc 'npm test'` → `npm test`. Codex wraps every command in a login shell. */
export function unwrapShell(command: unknown): string {
  const raw = commandText(command);
  const m = raw.match(/^(?:\S*\/)?(?:ba|z)?sh -l?c\s+(['"])([\s\S]*)\1\s*$/);
  return (m ? m[2]! : raw).trim();
}

function commandText(command: unknown): string {
  if (Array.isArray(command)) return command.map(String).join(" ");
  return typeof command === "string" ? command : "";
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

function changeVerb(kind: string | undefined): string {
  if (kind === "add") return "Wrote";
  return kind === "delete" ? "Deleted" : "Edited";
}

function relativeTo(cwd: string, path: unknown): string {
  const s = typeof path === "string" ? path : "";
  return isAbsolute(s) && s.startsWith(cwd) ? relative(cwd, s) || s : s;
}

/** Translates the JSON messages of `codex exec --json` into task events. */
export class CodexStream implements AgentStream {
  private lastText = "";
  private started = false;
  private sessionId: string | null;
  private turns = 0;
  private usage: RunUsage | null = null;
  /** The turn failed. */
  private failed: string | null = null;
  /** The last stream error, which may have been recovered from. */
  private errored: string | null = null;
  private commands = new CommandTracker((command) => {
    const label = command.status === "running" ? "Started" : `Command ${command.status}`;
    this.ctx.emit("tool", commandMessage(label, command), { tool: "shell", command });
  });

  constructor(
    private ctx: CodexStreamContext,
    private model: string | null,
    private resume?: string,
  ) {
    this.sessionId = resume ?? null;
  }

  handle(msg: Record<string, any>) {
    switch (msg.type) {
      case "thread.started":
        return this.onThreadStarted(msg);
      case "item.started":
      case "item.completed":
        if (msg.item && typeof msg.item === "object") this.onItem(msg.type === "item.started" ? "started" : "completed", msg.item);
        return;
      case "turn.completed":
        this.turns++;
        this.usage = addRunUsage(this.usage, usageFromTurn(msg.usage, this.model));
        return;
      case "turn.failed":
        this.failed = String(msg.error?.message ?? "The agent stopped with an error");
        return;
      case "error":
        // Codex also sends these for retries it recovers from; only the last one matters if the run fails.
        if (typeof msg.message === "string") this.errored = msg.message;
        return;
    }
  }

  finish({ code, stderr }: AgentExit): RunResult {
    this.commands.close(this.ctx.signal.aborted);
    // Reported before we decide whether the run succeeded: a failed run still used tokens.
    if (this.usage) this.ctx.onUsage?.(this.usage);
    if (this.ctx.signal.aborted) throw cancelledRun(this.sessionId);
    const detail = stderrExcerpt(stderr);
    if (this.resume && !this.started) {
      throw new SessionNotResumed(this.failed ?? this.errored ?? (detail || `exit code ${code}`));
    }
    if (this.failed) throw this.failure(this.failed);
    // A turn that completed is a success, even if a recovered error came before it.
    if (this.turns === 0 && this.errored) throw this.failure(this.errored);
    const exited = `Codex exited with code ${code}. ${detail}`;
    if (!this.started && !this.lastText) {
      throw this.failure(code === 0
        ? "Codex finished without sending any events Crane understands. Update Codex (npm i -g @openai/codex) and try again."
        : exited);
    }
    if (code !== 0 && !this.lastText) throw this.failure(exited);
    return { report: parseReport(this.lastText) };
  }

  private failure(message: string): AgentRunError {
    return new AgentRunError(message, { transient: isTransientFailure(message), sessionId: this.sessionId });
  }

  private onThreadStarted(msg: Record<string, any>) {
    this.started = true;
    if (typeof msg.thread_id === "string") {
      this.sessionId = msg.thread_id;
      this.ctx.onSession?.(msg.thread_id);
    }
    const verb = this.resume ? "resumed" : "started";
    const tuned = [this.model, this.ctx.effort ? `${this.ctx.effort} effort` : null].filter(Boolean).join(", ");
    this.ctx.emit("note", `Agent session ${verb} on Codex${tuned ? ` (${tuned})` : ""}`, { sessionId: msg.thread_id });
  }

  private onItem(phase: ItemPhase, item: Record<string, any>) {
    switch (item.type) {
      case "agent_message":
        return this.onAgentMessage(phase, item);
      case "command_execution":
        return this.commands.record(phase, item, unwrapShell(item.command), this.sessionId);
      case "file_change":
        return this.onFileChange(phase, item);
      case "web_search":
        if (phase === "started") this.ctx.emit("tool", `Searched the web for “${item.query ?? ""}”`, { tool: "web_search" });
        return;
      case "mcp_tool_call":
        if (phase === "started") this.ctx.emit("tool", `${item.server ?? "mcp"}: ${item.tool ?? "tool"}`, { tool: "mcp" });
        return;
      case "todo_list":
        if (phase === "started") this.ctx.emit("tool", "Updated its plan", { tool: "todo_list" });
        return;
      case "error":
        if (typeof item.message === "string") this.ctx.emit("note", item.message.slice(0, 600));
        return;
    }
  }

  private onAgentMessage(phase: ItemPhase, item: Record<string, any>) {
    if (phase !== "completed" || typeof item.text !== "string" || !item.text.trim()) return;
    this.lastText = item.text;
    emitAgentText(this.ctx.emit, item.text);
  }

  private onFileChange(phase: ItemPhase, item: Record<string, any>) {
    if (phase !== "completed") return;
    for (const c of (item.changes ?? []) as { path?: string; kind?: string }[]) {
      this.ctx.emit("tool", `${changeVerb(c.kind)} ${relativeTo(this.ctx.cwd, c.path)}`, { tool: "file_change" });
    }
  }
}
