/**
 * @deprecated Moved to `src/agent-protocol`. Re-exported here so branches
 * written against the old path still build; remove once none import it.
 * Re-export only: a second `AgentRunError` class would break `instanceof`.
 */
export {
  AgentRunError,
  isTransientFailure,
  type AgentDriver,
  type AgentJob,
  type ResolveConflictsJob,
  type RunContext,
  type RunResult,
} from "../agent-protocol/index.js";
