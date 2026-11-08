import type { GuardContext, GuardVerdict } from "@crane/agent-policy";

/**
 * What the command guard's hook entry (`command-guard-hook.ts`) and the
 * driver agree on. It imports only agent-policy's types, so the hook, which
 * starts once per tool call, loads nothing heavier than the classifier.
 */

/** Starts every reason the guard gives Claude Code for a deny, so a refusal can be recognized. */
export const GUARD_DENY_PREFIX = "Crane's command guard blocked this:";

/**
 * The hook writes `crane-guard <decision> <tool_use_id>` to stderr for every
 * call it answers. Claude Code shows a successful hook's stderr only in its
 * `hook_response` event, never to the model, so the stream can tell that the
 * guard ran for each Bash call (docs/command-guard.md, question 6).
 */
export const GUARD_LIVENESS = /^crane-guard (?:allow|deny|pass) (\S+)$/gm;

export function livenessLine(decision: GuardVerdict["decision"], toolUseId: string): string {
  return `crane-guard ${decision} ${toolUseId}\n`;
}

/** A PreToolUse hook's JSON answer. No answer leaves the call to Claude Code's own rules. */
export interface HookDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
}

function decision(permissionDecision: "allow" | "deny", reason: string): HookDecision {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } };
}

/**
 * Only "Most commands" may answer allow: an allow skips Claude Code's
 * allowlist in every mode, and its auto-mode classifier too. The classifier
 * already never allows outside `most`; this keeps that true here as well.
 */
export function hookDecision(verdict: GuardVerdict, access: GuardContext["access"]): HookDecision | null {
  if (verdict.decision === "deny") {
    const rules = verdict.overridable && verdict.rules.length ? ` The operator can allow it for this repo with: ${verdict.rules.join(", ")}.` : "";
    return decision("deny", `${GUARD_DENY_PREFIX} ${verdict.reason}${rules}`);
  }
  if (verdict.decision === "allow" && access === "most") {
    return decision("allow", "Crane's command guard allowed this: the repo lets agents run most commands.");
  }
  return null;
}

export function encodeGuardContext(ctx: GuardContext): string {
  return Buffer.from(JSON.stringify(ctx), "utf8").toString("base64url");
}

const ACCESS = new Set<unknown>(["listed", "most", "auto"]);
const PROFILES = new Set<unknown>(["worktree", "job"]);
const absolute = (value: unknown): value is string => typeof value === "string" && value.startsWith("/");

/** Decode and check the context from the hook's command line. Anything unexpected throws. */
export function decodeGuardContext(encoded: string | undefined): GuardContext {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("no readable run context");
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("the run context isn't an object");
  const ctx = value as Record<string, unknown>;
  if (!ACCESS.has(ctx.access)) throw new Error("the run context has no command access");
  if (!PROFILES.has(ctx.profile)) throw new Error("the run context has no profile");
  for (const key of ["worktree", "checkout", "craneHome"]) {
    if (!absolute(ctx[key])) throw new Error(`the run context's ${key} isn't an absolute path`);
  }
  if (typeof ctx.defaultBranch !== "string" || !ctx.defaultBranch) throw new Error("the run context has no default branch");
  if (ctx.home !== null && !absolute(ctx.home)) throw new Error("the run context's home isn't an absolute path");
  if (!Array.isArray(ctx.allowed) || !ctx.allowed.every((rule) => typeof rule === "string")) {
    throw new Error("the run context's allowed rules aren't a list");
  }
  return ctx as unknown as GuardContext;
}

/** The parts of Claude Code's PreToolUse input the guard reads. */
export interface HookInput {
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
}

export function parseHookInput(raw: string): HookInput {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("the hook input isn't an object");
  const msg = value as Record<string, unknown>;
  if (msg.hook_event_name !== undefined && msg.hook_event_name !== "PreToolUse") throw new Error("the hook input isn't a PreToolUse call");
  if (typeof msg.tool_name !== "string" || !msg.tool_name) throw new Error("the hook input names no tool");
  const input = msg.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("the hook input has no tool input");
  const toolUseId = typeof msg.tool_use_id === "string" && /^\S+$/.test(msg.tool_use_id) ? msg.tool_use_id : "unknown";
  return { tool: msg.tool_name, input: input as Record<string, unknown>, toolUseId };
}
