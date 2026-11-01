/**
 * The agent policy: Crane's deny list and how it reads permission rules. One
 * owner for what configuration (operator actions allowing a tool for a repo)
 * and execution (drivers deciding and explaining a refused call) both rely on.
 *
 * This is the source of `@crane/agent-policy`. It becomes its own package when
 * it gets a separate build target. Until then it compiles with the backend, and
 * `test/boundaries.test.ts` holds it to the package's rules:
 *
 * - It imports the rule grammar (`@crane/contracts/rules`) and nothing else: no
 *   factory, Store, drivers, prompts, subprocesses or Node modules.
 * - Everything else imports it through this file only, so becoming a package
 *   means swapping one specifier.
 *
 * Shared rule grammar and labels stay in `@crane/contracts`; the tools each
 * driver allows and its CLI arguments stay in that driver. Codex has no deny
 * list: its guard is its sandbox (`codexArgs` in `src/agents/codex.ts`).
 *
 * The command splitter is a best-effort reading of Claude Code's own rule
 * matching, used to suggest rules and spot overlaps with the deny list. It is
 * not a shell parser or a security boundary; Claude Code enforces the rules.
 */

export { ALWAYS_DENIED } from "./denied.js";
export { isAllowed, overlapsDenied, suggestRules } from "./permissions.js";
