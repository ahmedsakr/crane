import { ALWAYS_DENIED, overlapsDenied } from "@crane/agent-policy";
import { ruleLabel, type RepoTools } from "@crane/contracts";
import { parseRule } from "@crane/contracts/rules";
import type { Store } from "../../core/store.js";
import { toRule } from "../action-inputs.js";
import { needRepo } from "./repos.js";

function noteOnTask(store: Store, taskId: string | undefined, message: string, data: Record<string, unknown>) {
  const t = taskId ? store.getTask(taskId) : null;
  if (t) store.addEvent(t.id, "operator", message, data);
}

/**
 * Let every agent working in this repo use a tool or command from now on.
 * Crane's deny list still wins, so this can never allow pushing or merging.
 * `taskId` notes the decision on the task that prompted it.
 */
export function allowTool(store: Store, repoId: string, input: string, taskId?: string): RepoTools {
  const repo = needRepo(store, repoId);
  const rule = toRule(input);
  const parsed = parseRule(rule);
  if (!parsed) throw new Error(`“${input}” isn't a command or tool Crane can allow`);
  if (parsed.tool === "Bash" && (!parsed.pattern || /^[:*\s]*$/.test(parsed.pattern))) {
    throw new Error("Allowing every command would let agents run anything. Allow one command at a time");
  }
  if (overlapsDenied(rule, ALWAYS_DENIED)) {
    throw new Error(`Agents are never allowed to run ${ruleLabel(rule)}. Crane does that itself, and only when you approve`);
  }
  const tools = store.repoTools(repo.id);
  const next = {
    allowed: [...tools.allowed.filter((r) => r !== rule), rule],
    keptBlocked: tools.keptBlocked.filter((r) => r !== rule),
  };
  store.setRepoTools(repo.id, next);
  noteOnTask(store, taskId, `Allowed ${ruleLabel(rule)} for ${repo.name}`, { rule, repoId: repo.id });
  return next;
}

/** Stop suggesting this blocked command for the repo. It stays blocked, as it already was. */
export function keepBlocked(store: Store, repoId: string, input: string, taskId?: string): RepoTools {
  const repo = needRepo(store, repoId);
  const rule = toRule(input);
  const tools = store.repoTools(repo.id);
  const next = {
    allowed: tools.allowed.filter((r) => r !== rule),
    keptBlocked: [...tools.keptBlocked.filter((r) => r !== rule), rule],
  };
  store.setRepoTools(repo.id, next);
  noteOnTask(store, taskId, `Kept ${ruleLabel(rule)} blocked for ${repo.name}`, { rule, repoId: repo.id });
  return next;
}

/** Take back an allowed command. Agents will be blocked from it again, and Crane may ask about it again. */
export function disallowTool(store: Store, repoId: string, input: string): RepoTools {
  const repo = needRepo(store, repoId);
  const rule = toRule(input);
  const tools = store.repoTools(repo.id);
  if (!tools.allowed.includes(rule)) throw new Error(`${ruleLabel(rule)} isn't allowed for ${repo.name}`);
  const next = { ...tools, allowed: tools.allowed.filter((r) => r !== rule) };
  store.setRepoTools(repo.id, next);
  return next;
}
