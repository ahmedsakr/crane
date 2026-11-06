import type { BlockedTool, Task } from "@crane/contracts";
import { allowCommand } from "./shared.js";

/** A command to run next, and what it does. */
export type NextStep = [command: string, what: string];

/** The parts of a task its next steps depend on. */
export type NextStepTask = Pick<Task, "id" | "status" | "branch" | "autonomy" | "preApprovedAt" | "report">;

/** What `crane show` knows about a task beyond the task itself. */
export interface NextStepFacts {
  /** The repo's default branch. */
  main: string;
  /** Prerequisites that haven't landed, by id. */
  waiting: string[];
  /** The operator checkout the last merge left behind, if any. */
  checkoutBehind?: string | null;
  /** The first command agents were blocked from running on this task. */
  blocked?: BlockedTool;
}

/** The `crane show` hints: what the operator can do with a task now. Pure, so every status can be tested. */
export function nextSteps(task: NextStepTask, facts: NextStepFacts): NextStep[] {
  const next = stepsForStatus(task, facts);
  if (facts.blocked) next.push([allowCommand(facts.blocked, task.id), `let agents run it in ${facts.blocked.repoName}`]);
  return next;
}

function stepsForStatus(task: NextStepTask, facts: NextStepFacts): NextStep[] {
  const { id, status, branch } = task;
  switch (status) {
    case "needs_review": return reviewSteps(task, facts.main);
    case "queued":
    case "running": return activeSteps(task, facts);
    case "merging": return [[`crane watch ${id}`, "follow the merge"]];
    case "failed":
    case "cancelled": return [[`crane retry ${id}`, "run it again"]];
    case "approved":
    case "done": return branch ? [[`crane merge ${id}`, `merge into ${facts.main} and push`]] : [];
    case "merged": return facts.checkoutBehind ? [[`git -C ${facts.checkoutBehind} pull --ff-only`, "catch your checkout up, once it's clean"]] : [];
    case "rejected": return [];
  }
}

function reviewSteps(task: NextStepTask, main: string): NextStep[] {
  const { id, branch } = task;
  const next: NextStep[] = [];
  next.push([`crane approve ${id}`, branch ? `merge into ${main} and push` : "mark as reviewed"]);
  if (branch) next.push([`crane approve ${id} --no-merge`, `approve only, keep ${branch}`]);
  next.push([`crane decline ${id}`, branch ? "discard the branch" : "dismiss"]);
  if (branch) next.push([`crane diff ${id}`, "see the changes"]);
  if (task.report?.findings.length && task.autonomy === "observe") next.push([`crane follow-up ${id} 1`, "act on finding 1"]);
  return next;
}

function activeSteps(task: NextStepTask, { main, waiting }: NextStepFacts): NextStep[] {
  const { id, status } = task;
  const next: NextStep[] = [];
  if (status === "queued" && waiting.length) {
    next.push([`crane waive ${id} -m "…"`, `start it without ${waiting.join(", ")}, accepting a reduced scope`]);
  }
  next.push([`crane watch ${id}`, "follow along live"]);
  if (status === "running" && task.branch) next.push([`crane diff ${id}`, "see the changes so far"]);
  next.push([`crane cancel ${id}`, "stop it"]);
  if (task.autonomy === "observe") return next;
  next.push(task.preApprovedAt
    ? [`crane pre-approve ${id} --undo`, "wait for your review instead of merging"]
    : [`crane pre-approve ${id}`, `merge into ${main} once its checks pass`]);
  return next;
}
