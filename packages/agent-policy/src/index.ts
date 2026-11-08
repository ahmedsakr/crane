/**
 * The agent policy: Crane's deny list, command guard and permission rules. One
 * owner for what configuration (operator actions allowing a tool for a repo)
 * and execution (drivers deciding and explaining a refused call) both rely on.
 *
 * `test/boundaries.test.ts` holds this private package to its rules:
 *
 * - It imports the rule grammar (`@crane/contracts/rules`) and nothing else: no
 *   factory, Store, drivers, prompts, subprocesses or Node modules.
 * - Everything else imports it through the single package entry point.
 *
 * Shared rule grammar and labels stay in `@crane/contracts`; the tools each
 * driver allows and its CLI arguments stay in that driver. Codex has no deny
 * list: its guard is its sandbox (`codexArgs` in `packages/agent-drivers/src/codex.ts`).
 *
 * The deterministic command guard also scans raw text for dangerous operations.
 * It is best-effort protection against mistakes and prompt injection, not a
 * boundary against a determined adversary: it cannot resolve symlinks or inspect
 * arbitrary programs. The worktree, driver sandbox and Crane-only merging remain
 * the boundaries. The internal command splitter is not a shell parser.
 */

export { ALWAYS_DENIED } from "./denied.js";
export { isAllowed, overlapsDenied, suggestRules } from "./permissions.js";
export { classifyToolCall } from "./guard.js";
export type { GuardCategory, GuardContext, GuardVerdict } from "./guard.js";
