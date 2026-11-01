/**
 * The agent protocol: what the factory and every agent driver agree on. The
 * driver interface and its run context, the run error retry handling checks
 * with `instanceof`, the `crane-report` block agents end with and its parser,
 * and how run costs combine.
 *
 * This is the source of `@crane/agent-protocol`. It becomes its own package
 * when it gets a separate build target. It imports contract types through
 * `@crane/contracts` and still compiles with the backend, and
 * `test/boundaries.test.ts` holds it to the package's rules:
 *
 * - It imports contract types (`@crane/contracts`) and nothing else: no
 *   concrete drivers, provider price tables, prompts, safety policy,
 *   subprocesses, Store or factory code.
 * - Everything else imports it through this file only, so becoming a package
 *   means swapping one specifier.
 *
 * `RunContext` carries full `Task` and `Repo` records, so this is Crane's
 * protocol, not a general agent SDK.
 */

export {
  AgentRunError,
  isTransientFailure,
  type AgentDriver,
  type AgentJob,
  type ResolveConflictsJob,
  type RunContext,
  type RunResult,
  type SiblingTask,
} from "./driver.js";
export { REPORT_FENCE, parseReport } from "./report.js";
export { combinedCost } from "./usage.js";
