/**
 * The agent policy: Crane's deny list and how it reads permission rules. One
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
 * The command splitter is a best-effort reading of Claude Code's own rule
 * matching, used to suggest rules and spot overlaps with the deny list. It is
 * not a shell parser or a security boundary; Claude Code enforces the rules.
 */

export { ALWAYS_DENIED } from "./denied.js";
export { isAllowed, overlapsDenied, suggestRules } from "./permissions.js";
