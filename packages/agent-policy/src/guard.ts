import { ALWAYS_DENIED } from "./denied.js";
import { isAllowed, ruleForCommand, splitCommand } from "./permissions.js";
import { candidates, executable, scanCommands } from "./guard-shell.js";
import { credentialPath, redirectTargets, resolvePath, within, writeCategory, writeTargets } from "./guard-paths.js";
import { sharedGit } from "./guard-git.js";
import { readOnlyInspection } from "./guard-inspect.js";
import { operatorCli, operatorHttp } from "./guard-operator.js";
import { concealedCode, GUARD_REASONS, machineCategory, outwardCategory, sendsEnvironment } from "./guard-rules.js";
import type { GuardCategory, GuardCommand, GuardContext, GuardVerdict } from "./guard-types.js";

export type { GuardCategory, GuardContext, GuardVerdict } from "./guard-types.js";

function denied(category: GuardCategory, rules: string[] = [], overridable = false): GuardVerdict {
  return { decision: "deny", category, reason: GUARD_REASONS[category], rules, overridable };
}

function hardCommand(part: GuardCommand, ctx: GuardContext): GuardCategory | null {
  const command = [executable(part.words[0] ?? ""), ...part.words.slice(1)].join(" ");
  if (isAllowed(ALWAYS_DENIED, "Bash", { command })) return "deny-list";
  if (executable(part.words[0] ?? "") === "git" && sharedGit(part, ctx)) return "shared-git";
  if (operatorCli(part.words) || operatorHttp(part.words)) return "operator-actions";
  const machine = machineCategory(part.words);
  if (machine) return machine;
  for (const target of writeTargets(part.words)) {
    const category = writeCategory(target, part.cwd, ctx);
    if (category) return category;
  }
  return null;
}

function hardBash(raw: string, parts: GuardCommand[], ctx: GuardContext): GuardCategory | null {
  if (splitCommand(raw).some((command) => isAllowed(ALWAYS_DENIED, "Bash", { command }))) return "deny-list";
  if (raw.includes("crane.db")) return "operator-actions";
  for (const part of parts) {
    for (const target of redirectTargets(part.words)) {
      if (ctx.profile === "inspect" && target === "/dev/null") continue;
      const category = writeCategory(target, part.cwd, ctx);
      if (category) return category;
    }
    for (const candidate of candidates(part)) {
      const category = hardCommand(candidate, ctx);
      if (category) return category;
    }
  }
  if (parts.some((part) => part.words.some((word) => credentialPath(word, part, ctx))) || sendsEnvironment(parts)) return "credentials";
  if (concealedCode(raw, parts)) return "remote-code";
  return null;
}

function outwardBash(raw: string, parts: GuardCommand[], ctx: GuardContext): GuardVerdict | null {
  const rules: string[] = [];
  let blocked: GuardCategory | null = null;
  // Keep allowed parent commands intact, including quoted shell arguments.
  const unchecked = ctx.allowed.length
    ? scanCommands(splitCommand(raw).filter((command) => !isAllowed(ctx.allowed, "Bash", { command })).join("\n"), ctx)
    : parts;
  for (const part of unchecked) {
    for (const candidate of candidates(part)) {
      const category = outwardCategory(candidate.words);
      if (!category || isAllowed(ctx.allowed, "Bash", { command: candidate.text })) continue;
      blocked ??= category;
      const rule = ruleForCommand(candidate.text);
      if (rule && !rules.includes(rule)) rules.push(rule);
    }
  }
  return blocked ? denied(blocked, rules, true) : null;
}

function fileTool(tool: string, input: Record<string, unknown>, ctx: GuardContext): GuardVerdict | null {
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return null;
  const file = input.file_path ?? input.notebook_path;
  if (typeof file !== "string") return null;
  const category = writeCategory(file, ctx.worktree, ctx);
  if (category === "agent-config") return denied(category);
  const path = resolvePath(file, ctx.worktree, ctx);
  if (!path || !within(path, ctx.worktree)) return denied("outside-worktree");
  return null;
}

/**
 * Best-effort protection against mistakes and prompt injection, not a shell
 * interpreter or an adversarial sandbox: it cannot resolve symlinks or inspect
 * arbitrary programs. Raw text is intentionally scanned even when it is data.
 */
export function classifyToolCall(call: { tool: string; input: Record<string, unknown> }, ctx: GuardContext): GuardVerdict {
  const pass: GuardVerdict = { decision: "pass", category: null, reason: "Crane's command guard found no blocked operation.", rules: [], overridable: false };
  if (call.tool !== "Bash") return fileTool(call.tool, call.input, ctx) ?? pass;
  const raw = typeof call.input.command === "string" ? call.input.command : "";
  const inspect = ctx.profile === "inspect" && ctx.access !== "listed" && readOnlyInspection(raw, ctx);
  // The positive grammar has no cd or subshells. Every stage of an approved
  // pipeline therefore starts in the checkout, including Git after a pipe.
  const parts = scanCommands(raw, ctx).map((part) => inspect ? { ...part, cwd: ctx.worktree } : part);
  const hard = hardBash(raw, parts, ctx);
  if (hard) return denied(hard);
  if (ctx.access === "listed") return pass;
  const outward = outwardBash(raw, parts, ctx);
  if (outward) return outward;
  if (ctx.profile === "inspect") return inspect ? { ...pass, decision: "allow" } : pass;
  if (ctx.access === "auto") return pass;
  return { ...pass, decision: "allow" };
}
