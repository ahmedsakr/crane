import { AgentRunError, isTransientFailure, parseReport, type RunContext, type RunResult } from "@crane/agent-protocol";
import { classifyToolCall, overlapsDenied, suggestRules, type GuardContext } from "@crane/agent-policy";
import type { BlockedCall, CommandEvidence, RunUsage } from "@crane/contracts";
import { cancelledRun, SessionNotResumed, stderrExcerpt, type AgentExit, type AgentStream } from "./agent-process.js";
import { checkResultsSummary, claudeToolResult, claudeValidationSummary } from "./claude-evidence.js";
import { checkRecordsSince } from "./check-results.js";
import { emitAgentText } from "./cli.js";
import { commandMessage, CommandTracker, safeEvidenceText } from "./command-evidence.js";
import { GuardLiveness } from "./guard-liveness.js";
import { AutoModeWatch, CLASSIFIER_DENIAL, classifierReason } from "./auto-mode-stream.js";
import { GUARD_DENY_PREFIX } from "./command-guard-protocol.js";

/** What a stream hears the run through. */
export type ClaudeStreamContext = Pick<RunContext, "emit" | "signal" | "effort" | "maxTurns" | "onSession" | "onUsage"> & Partial<Pick<RunContext, "cwd">>;

/** The rules the run was given, so a refusal can say what would have allowed it. */
export interface ToolRules {
  allowed: string[];
  denied: string[];
}

/** Keep driver evidence separate from Crane's heuristic permission suggestions. */
export function describeBlocked(
  tool: string,
  input: Record<string, unknown>,
  tools: ToolRules,
  evidence: Pick<BlockedCall, "toolUseId" | "refusal" | "guard"> & Partial<Pick<BlockedCall, "rules">> = {},
): { message: string; data: BlockedCall } {
  const command = tool === "Bash" && typeof input.command === "string" ? input.command : undefined;
  let rules: string[] = [];
  if (evidence.guard?.overridable !== false) rules = evidence.rules ?? suggestRules(tool, input, tools.allowed);
  // Refused on purpose: nothing to offer, and any rule we suggested would lose to the deny list anyway.
  if (rules.some((r) => overlapsDenied(r, tools.denied))) rules = [];
  const target = [input.file_path, input.path, input.url, input.pattern].find((v) => typeof v === "string") as string | undefined;
  const what = command ?? (target ? `${tool} ${target}` : tool);
  return {
    message: `Blocked: ${what.split("\n")[0]!.slice(0, 160)}`,
    data: {
      ...evidence,
      tool, ...(command ? { command: command.slice(0, 2000) } : {}), rules,
      ...(evidence.refusal ? { refusal: { ...evidence.refusal, reason: evidence.refusal.reason?.slice(0, 4000) ?? null } } : {}),
    },
  };
}

/**
 * Claude Code's wording when the permission system refuses a tool call. Older
 * releases say "Claude requested permissions to … haven't granted it yet" or
 * "Permission to … has been denied"; current ones say "This command requires
 * approval" or "… The following part requires approval: …".
 */
const DENIAL_TEXT =
  /Claude requested permissions? to |haven't granted it yet|^\s*Permission to (use|read|write|edit) .* has been denied|\b(command|part) requires approval\b/i;

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

function completedStatus(result: { interrupted?: boolean; isError: boolean | null }): string {
  if (result.interrupted) return "interrupted";
  return result.isError ? "failed" : "completed";
}

/** Translates the JSON messages of `claude -p --output-format stream-json` into task events. */
export class ClaudeStream implements AgentStream {
  private finalText = "";
  private lastText = "";
  private model: string | null = null;
  private sessionId: string | null;
  private errored: string | null = null;
  private outOfTurns = false;
  private started = false;
  /** Tool calls by id, so a refusal can be reported with what was asked for. */
  private calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private commandOutcomes = new Map<string, CommandEvidence>();
  private commands = new CommandTracker((command) => this.onCommand(command));
  private reported = new Set<string>();
  private guard: GuardLiveness;
  private autoMode: AutoModeWatch;
  /** Check-handle records from before this invocation describe an earlier one. */
  private startedAt = new Date();

  /** Inspect runs have a guard but never request auto mode, even in auto repos. */
  constructor(
    private ctx: ClaudeStreamContext,
    private tools: ToolRules,
    private resume?: string,
    private guardContext?: GuardContext,
  ) {
    this.sessionId = resume ?? null;
    const auto = guardContext?.access === "auto" && guardContext.profile !== "inspect";
    this.guard = new GuardLiveness(!!guardContext, ctx.emit, auto);
    this.autoMode = new AutoModeWatch(auto, ctx.emit);
  }

  handle(msg: Record<string, any>) {
    if (msg.type === "system" && msg.subtype === "init") this.onInit(msg);
    else if (msg.type === "system" && msg.subtype === "hook_response") this.guard.onHookResponse(msg);
    else if (msg.type === "system" && msg.subtype === "permission_denied") this.onPermissionDenied(msg);
    else if (msg.type === "assistant") this.onAssistant(msg);
    else if (msg.type === "user") this.onUser(msg);
    else if (msg.type === "result") this.onResult(msg);
  }

  onProcessError() {
    this.commands.close(this.ctx.signal.aborted);
  }

  finish({ code, stderr }: AgentExit): RunResult {
    this.commands.close(this.ctx.signal.aborted);
    if (this.ctx.signal.aborted) throw cancelledRun(this.sessionId);
    const detail = stderrExcerpt(stderr);
    if (this.resume && !this.started) throw new SessionNotResumed(this.errored ?? (detail || `exit code ${code}`));
    if (this.errored) throw this.failure(this.errored);
    if (code !== 0 && !this.finalText) throw this.failure(`Claude Code exited with code ${code}. ${detail}`);
    const report = parseReport(this.finalText || this.lastText);
    const qualification = claudeValidationSummary([...this.commandOutcomes.values()]);
    if (qualification) report.summary += `\n\n${qualification}`;
    const checks = this.ctx.cwd ? checkResultsSummary(checkRecordsSince(this.ctx.cwd, this.startedAt)) : "";
    if (checks) report.summary += `\n\n${checks}`;
    return { report };
  }

  private failure(message: string): AgentRunError {
    return new AgentRunError(message, {
      transient: !this.outOfTurns && isTransientFailure(message),
      sessionId: this.sessionId,
      ...(this.outOfTurns ? { limit: "turns" as const } : {}),
    });
  }

  private onCommand(command: CommandEvidence) {
    this.commandOutcomes.set(command.commandId, command);
    const label = command.status === "running" ? "Ran" : `Command ${command.status}`;
    this.ctx.emit("tool", commandMessage(label, command), {
      tool: "Bash", toolUseId: command.itemId, sessionId: command.sessionId, command,
    });
  }

  private onInit(msg: Record<string, any>) {
    this.started = true;
    this.model = typeof msg.model === "string" ? msg.model : null;
    if (typeof msg.session_id === "string") {
      this.sessionId = msg.session_id;
      this.ctx.onSession?.(msg.session_id);
    }
    const verb = this.resume ? "resumed" : "started";
    const effort = this.ctx.effort ? `, ${this.ctx.effort} effort` : "";
    this.ctx.emit("note", `Agent session ${verb}${msg.model ? ` on ${msg.model}` : ""}${effort}`, { sessionId: msg.session_id });
    this.autoMode.onInit(msg);
  }

  /** Classifier blocks arrive here first, with a clean reason; the tool_result and permission_denials repeat them. */
  private onPermissionDenied(msg: Record<string, any>) {
    const block = this.autoMode.onPermissionDenied(msg);
    if (!block) return;
    const call = this.calls.get(block.toolUseId);
    const tool = call?.name ?? block.tool;
    if (tool) this.blocked(block.toolUseId, tool, call?.input ?? block.input ?? {}, { source: "claude.auto-mode", reason: block.reason });
  }

  private onAssistant(msg: Record<string, any>) {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        this.lastText = block.text;
        emitAgentText(this.ctx.emit, block.text);
      } else if (block.type === "tool_use") {
        this.onToolUse(block);
      }
    }
  }

  private onToolUse(block: Record<string, any>) {
    if (block.id) this.calls.set(block.id, { name: block.name, input: block.input ?? {} });
    if (block.name === "Bash") {
      this.commands.record("started", { id: block.id }, typeof block.input?.command === "string" ? block.input.command : "", this.sessionId);
    } else {
      this.ctx.emit("tool", safeEvidenceText(describeTool(block.name, block.input ?? {}), 240).text, {
        tool: block.name, toolUseId: block.id ?? null, sessionId: this.sessionId,
      });
    }
  }

  private onUser(msg: Record<string, any>) {
    // Report refusals as they happen. The result's permission_denials is the full record.
    const results = (Array.isArray(msg.message?.content) ? msg.message.content : [])
      .filter((block: Record<string, unknown>) => block.type === "tool_result");
    for (const block of results) {
      if (!block.tool_use_id) continue;
      // Top-level SDK metadata describes a single result; don't assign it to several parallel calls.
      this.onToolResult(block, results.length === 1 ? msg.tool_use_result : undefined);
    }
  }

  private onToolResult(block: Record<string, any>, metadata: unknown) {
    const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
    const call = this.calls.get(block.tool_use_id);
    const result = claudeToolResult(block, metadata);
    this.ctx.emit("tool", `${call?.name ?? "Tool"} returned${result.isError ? " an error" : " a result"}`, {
      tool: call?.name ?? null, toolUseId: block.tool_use_id, sessionId: this.sessionId, result,
    });
    if (call?.name === "Bash") {
      this.commands.record("completed", { id: block.tool_use_id, exit_code: result.exitCode, status: completedStatus(result) }, "", this.sessionId);
      this.guard.onBashResult(block.tool_use_id);
    }
    if (block.is_error && call && result.content.text.includes(GUARD_DENY_PREFIX)) {
      this.guardBlocked(block.tool_use_id, call, result.content.text);
    } else if (block.is_error && call && result.content.text.includes(CLASSIFIER_DENIAL)) {
      this.blocked(block.tool_use_id, call.name, call.input, { source: "claude.auto-mode", reason: classifierReason(result.content.text) });
    } else if (block.is_error && call && DENIAL_TEXT.test(text)) {
      this.blocked(block.tool_use_id, call.name, call.input, { source: "claude-code.tool_result", reason: text });
    }
  }

  private guardBlocked(id: string, call: { name: string; input: Record<string, unknown> }, text: string) {
    const reason = text.slice(text.indexOf(GUARD_DENY_PREFIX) + GUARD_DENY_PREFIX.length).trim();
    const verdict = this.guardContext ? classifyToolCall({ tool: call.name, input: call.input }, this.guardContext) : null;
    // Hook failures carry the marker too. Never offer a rule when the call couldn't be classified.
    const failed = reason.startsWith("the guard couldn't check this call");
    const denied = !failed && verdict?.decision === "deny" ? verdict : null;
    const guard = { category: denied?.category ?? "guard-error", overridable: denied?.overridable ?? false };
    this.blocked(id, call.name, call.input, { source: "crane.guard", reason }, { guard, rules: denied?.rules ?? [] });
  }

  private onResult(msg: Record<string, any>) {
    // Reported before we decide whether the run succeeded: a failed run still cost this.
    this.ctx.onUsage?.(usageFromResult(msg, this.model));
    if (typeof msg.session_id === "string") this.sessionId = msg.session_id;
    this.finalText = typeof msg.result === "string" ? msg.result : this.lastText;
    const denials: Record<string, any>[] = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
    denials.forEach((d, i) => {
      // The summary identifies refused calls but supplies no decision reason.
      if (d?.tool_name) this.blocked(String(d.tool_use_id ?? `denial-${i}`), d.tool_name, d.tool_input ?? {}, {
        source: "claude-code.permission_denials", reason: null,
      });
    });
    if (msg.subtype === "error_max_turns") {
      this.outOfTurns = true;
      this.errored = `Stopped after ${msg.num_turns ?? this.ctx.maxTurns} turns, the most one run may take. Raise it with crane serve --max-turns or CRANE_MAX_TURNS`;
    } else if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
      const detail = Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join("; ") : null;
      this.errored = (typeof msg.result === "string" && msg.result) || detail || `Agent stopped: ${msg.subtype ?? "error"}`;
    }
  }

  private blocked(
    id: string, name: string, input: Record<string, unknown>, refusal: NonNullable<BlockedCall["refusal"]>,
    evidence: Pick<BlockedCall, "guard"> & Partial<Pick<BlockedCall, "rules">> = {},
  ) {
    if (this.reported.has(id)) return;
    this.reported.add(id);
    const { message, data } = describeBlocked(name, input, this.tools, { ...evidence, toolUseId: id, refusal });
    this.ctx.emit("blocked", message, { ...data });
  }
}
