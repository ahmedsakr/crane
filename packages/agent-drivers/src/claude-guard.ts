import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardContext } from "@crane/agent-policy";
import type { RunContext } from "@crane/agent-protocol";
import { autoModeSettings } from "./auto-mode-settings.js";
import { encodeGuardContext } from "./command-guard-protocol.js";

/** The tools whose calls the guard checks: shell commands and file writes. */
export const GUARDED_TOOLS = "Bash|Edit|Write|MultiEdit|NotebookEdit";

/**
 * Seconds Claude Code gives the hook. The spike timed it at 0.5–2.3 s, almost
 * all Node start-up. A timeout counts as no decision, which leaves the call to
 * the allowlist, and the stream notes it (see `guard-liveness.ts`).
 */
export const GUARD_TIMEOUT_SECONDS = 10;

/**
 * The compiled hook. Repository tests load the driver from `src/` through tsx,
 * where the hook still runs from the package build. Never run without the
 * guard: a missing hook stops the run rather than falling back silently.
 */
export function guardHookPath(): string {
  const path = compiledScript("command-guard-hook.js");
  if (path) return path;
  throw new Error(`Crane's command guard isn't built next to ${fileURLToPath(new URL(".", import.meta.url))}, so the agent wasn't started. Run npm run build:packages, then retry the task.`);
}

function compiledScript(file: string): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [join(here, file), join(here, "..", "dist", file)].find((path) => existsSync(path)) ?? null;
}

/**
 * The shell words that start Crane's check handle (`check-handle.ts`), or
 * null when it isn't built: agents then validate as before, without it.
 */
export function checkHandleCommand(): string | null {
  const path = compiledScript("check-handle.js");
  return path ? `node ${quote(path)}` : null;
}

/** What the guard needs to know about this run. `allowed` is the operator's rules, not Crane's defaults. */
export function guardContext(ctx: RunContext, allowed: string[]): GuardContext {
  const worktree = resolve(ctx.cwd);
  return {
    access: ctx.commandAccess ?? "listed",
    profile: ctx.job ? "job" : inspectionProfile(ctx),
    worktree,
    checkout: ctx.repo ? resolve(ctx.repo.path) : worktree,
    defaultBranch: ctx.repo?.defaultBranch || "main",
    // The factory always supplies it; this is paths.ts's default for a driver used on its own.
    craneHome: resolve(ctx.craneHome ?? process.env.CRANE_HOME ?? join(homedir(), ".crane")),
    home: homedir() || null,
    allowed,
  };
}

function inspectionProfile(ctx: RunContext): "inspect" | "worktree" {
  return ctx.task.autonomy === "observe" ? "inspect" : "worktree";
}

/** Listed investigate-only runs retain their existing, unhooked permissions. */
export function guardForRun(ctx: RunContext, allowed: string[]): GuardContext | undefined {
  if (!ctx.job && ctx.task.autonomy === "observe" && (ctx.commandAccess ?? "listed") === "listed") return undefined;
  return guardContext(ctx, allowed);
}

function quote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The shell command Claude Code runs for each guarded call. */
export function guardCommand(context: GuardContext): string {
  return `${quote(process.execPath)} ${quote(guardHookPath())} ${encodeGuardContext(context)}`;
}

/**
 * Inline settings for `claude --settings`: the guard as a PreToolUse hook,
 * plus Crane's context for the auto-mode classifier in an `auto` repo.
 */
export function claudeSettings(context: GuardContext): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        { matcher: GUARDED_TOOLS, hooks: [{ type: "command", command: guardCommand(context), timeout: GUARD_TIMEOUT_SECONDS }] },
      ],
    },
    ...(context.access === "auto" && context.profile !== "inspect" ? { autoMode: autoModeSettings(context) } : {}),
  };
}
