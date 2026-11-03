/**
 * The agent protocol: what the factory and every agent driver agree on. The
 * driver interface and its run context, the run error retry handling checks
 * with `instanceof`, the `crane-report` block agents end with and its parser,
 * and how run costs combine.
 *
 * `test/boundaries.test.ts` holds this private package to its rules:
 *
 * - It imports contract types (`@crane/contracts`) and nothing else: no
 *   concrete drivers, provider price tables, prompts, safety policy,
 *   subprocesses, Store or factory code.
 * - Everything else imports it through the single package entry point.
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
export { addRunUsage, combinedCost } from "./usage.js";
