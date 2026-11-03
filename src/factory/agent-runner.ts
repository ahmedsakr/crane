import { driverLabel, type RunUsage } from "@crane/contracts";
import { AgentRunError, addRunUsage, type AgentDriver, type RunContext, type RunResult } from "@crane/agent-protocol";
import type { Store } from "../core/store.js";
import { driverSettings, isAvailable } from "./drivers.js";
import { sleep } from "./run-limits.js";
import { siblingTasksFor } from "./task-context.js";

export interface AgentRunnerDeps {
  store: Store;
  /** Most turns one agent run may take. 0 for no limit. */
  maxTurns: number;
  /** How long to wait before retrying a transient failure, before jitter. */
  retryDelayMs: number;
}

/** What the caller decides about a run. The runner fills in usage, tools, limits and settings. */
export type AgentRunRequest = Omit<RunContext, "onUsage" | "allowedTools" | "maxTurns" | "model" | "effort">;

/**
 * Run the agent, giving a transient failure (overload, rate limit, network)
 * one more try after a pause. The retry resumes the same session when there
 * is one, so the agent picks up where it stopped instead of starting over.
 */
async function runWithRetry(deps: AgentRunnerDeps, driver: AgentDriver, ctx: RunContext): Promise<RunResult> {
  const { store } = deps;
  const run = async (resumeSession = ctx.resumeSession) => {
    const current = store.getTask(ctx.task.id) ?? ctx.task;
    return driver.run({
      ...ctx,
      // Operator authorization may change between resolver phases or retry attempts.
      task: { ...ctx.task, preApprovedAt: current.preApprovedAt, visualReview: current.visualReview },
      resumeSession,
      commandEvidence: store.commandEvidence(ctx.task.id),
      siblingTasks: ctx.repo && !ctx.job ? await siblingTasksFor(store, ctx.task, ctx.repo) : undefined,
      prerequisites: !ctx.job && ctx.task.prerequisites.length ? store.prerequisiteStates(ctx.task) : undefined,
      postmortemPrompt: !ctx.job && ctx.task.postmortemOf ? store.postmortemPrompt(ctx.task.postmortemOf) : undefined,
    });
  };
  try {
    return await run();
  } catch (err) {
    if (ctx.signal.aborted || !(err instanceof AgentRunError) || !err.transient) throw err;
    // Jitter, so a crew that all hit the same overload doesn't come back at once.
    const wait = Math.round(deps.retryDelayMs * (0.8 + Math.random() * 0.4));
    const reason = err.message.split("\n")[0]!.slice(0, 200).replace(/\.$/, "");
    ctx.emit("note", `${reason}. Trying once more in ${Math.max(1, Math.round(wait / 1000))}s`, { retry: true });
    await sleep(wait, ctx.signal);
    return run(err.sessionId ?? ctx.resumeSession);
  }
}

/**
 * Run the driver with a row in the runs ledger around it, so every run's
 * cost lands on its task: succeeded, failed, or cancelled. A retry after a
 * transient failure counts toward the same run.
 */
export async function runAgent(
  deps: AgentRunnerDeps,
  agentId: string,
  driver: AgentDriver,
  ctx: AgentRunRequest,
): Promise<RunResult> {
  const { store } = deps;
  if (!(await isAvailable(driver))) {
    throw new Error(
      `${driverLabel(driver.name)} isn't installed where the factory runs, or didn't answer. Install it and restart the factory, or retry the task on another agent.`,
    );
  }
  store.setAgentDriver(agentId, driver.name);
  const runId = store.startRun({
    taskId: ctx.task.id,
    kind: ctx.job?.kind ?? "work",
    agentId,
    driver: driver.name,
  });
  let usage: RunUsage | null = null;
  // A driver can report more than once in a run (a failed resume, then a fresh session), so add them up.
  const onUsage = (u: RunUsage) => {
    usage = addRunUsage(usage, u);
  };
  // Read at the start of every run, so a change on the Crew page applies to the next one without a restart.
  const { model, effort } = driverSettings((k) => store.getSetting(k), driver.name);
  // Task overrides belong to their chosen driver, including after a restart.
  const taskSettings = ctx.task.driver === driver.name ? ctx.task : null;
  try {
    const result = await runWithRetry(deps, driver, {
      ...ctx,
      onUsage,
      allowedTools: ctx.repo ? store.repoTools(ctx.repo.id).allowed : [],
      maxTurns: deps.maxTurns || undefined,
      model: taskSettings?.model ?? taskSettings?.driverSettings?.model ?? model ?? undefined,
      effort: taskSettings?.effort ?? taskSettings?.driverSettings?.effort ?? effort ?? undefined,
    });
    store.finishRun(runId, "succeeded", usage);
    return result;
  } catch (err) {
    const cancelled = ctx.signal.aborted || store.getTask(ctx.task.id)?.status === "cancelled";
    store.finishRun(runId, cancelled ? "cancelled" : "failed", usage);
    throw err;
  }
}
