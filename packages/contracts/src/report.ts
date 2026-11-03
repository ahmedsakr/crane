/** Agent reports, acceptance and candidate review evidence. */
import type { Task } from "./task.js";

export interface Finding {
  title: string;
  detail: string;
  /** How much this matters, from the agent's point of view. */
  impact: "low" | "medium" | "high";
  /** Rough size of the work to act on it. */
  effort: "small" | "medium" | "large";
}

export interface Report {
  /** Untrusted research output; validated again before it becomes a goal's draft plan. */
  goalPlan?: unknown;
  /** Missing or non-completed outcomes require operator review for implementation work. */
  completion?: { status: "completed" | "blocked" | "incomplete" | "already_satisfied"; reason: string; evidence: string };
  /** Factory-owned Git evidence, never read from agent output. */
  hasContribution?: boolean;
  /** Agent classification only; operator decisions live on Task.visualReview. Missing means unknown. */
  visualReview?: { required: boolean; reason: string };
  /** Factory-owned evidence; never accepted from agent output. Full reports are available on task detail. */
  validation?: ValidationRun[];
  summary: string;
  findings: Finding[];
  /** Files the agent changed, when it was allowed to change any. */
  changedFiles: string[];
  /** Agent paths are relative to the worktree; Crane replaces them with retained attachment names. */
  screenshots?: Screenshot[];
  /** The agent's account of each of the task's acceptance criteria. See `unmetAcceptance`. */
  acceptance?: AcceptanceResult[];
}

/** A dedicated completion hold, independent of advisory findings and acceptance lists. */
export function completionReviewReason(task: Pick<Task, "autonomy" | "report">): string | null {
  if (task.autonomy === "observe") return null;
  const completion = task.report?.completion;
  if (!completion) return "The report has no valid completion outcome.";
  if (completion.status !== "completed") return `${completion.status}: ${completion.reason}${completion.evidence ? ` Evidence: ${completion.evidence}` : ""}`;
  if (task.report?.hasContribution !== true) return "Git shows no new contribution, or contribution evidence is unavailable. Review whether the task is already satisfied.";
  return null;
}

/** One acceptance criterion, as the agent reported it. */
export interface AcceptanceResult {
  /** The criterion's text, as the task gave it. */
  criterion: string;
  met: boolean;
  /** What the agent observed: a command and its output, a file, a test. */
  evidence: string;
}

export interface Screenshot {
  path: string;
  caption: string;
}

export interface ValidationRun {
  phase: "review" | "merge";
  commit: string;
  command: string | null;
  status: "passed" | "failed" | "blocked" | "unconfigured";
  exitCode: number | null;
  logs: string;
  durationMs: number;
}

/**
 * Where a task's review stands once its report is final, so a restart resumes
 * validation rather than the agent. Written only by the factory, never from agent output.
 */
export interface ReviewCheckpoint {
  commit: string;
  tree: string;
  /** The check list these results answer. */
  checks: string[];
  /** Null when the installed dependencies couldn't be verified, which never matches. */
  dependencies: string | null;
  /** A hash, so it can't expose what's in the factory's environment. */
  environment: string;
  /** Commands that passed with exactly these inputs. Their results are in `report.validation`. */
  passed: string[];
}

export interface VisualReview {
  status: "pending" | "not_required" | "inspected" | "waived";
  commit: string;
  tree: string;
  /** The task branch this candidate came from, when `commit` is a merge of it rather than its tip. */
  branchCommit?: string;
  note: string;
  decidedAt: string | null;
}

export function visualReviewPending(task: Pick<Task, "branch" | "visualReview" | "preApprovedAt">): boolean {
  return !!task.branch && !task.preApprovedAt && (!task.visualReview || task.visualReview.status === "pending");
}

export function visualReviewWaivedByPreApproval(task: Pick<Task, "visualReview" | "preApprovedAt">): boolean {
  return !!task.preApprovedAt && (!task.visualReview || task.visualReview.status === "pending");
}

const normalCriterion = (c: string) => c.trim().replace(/\s+/g, " ").toLowerCase();

/** What the report says about one acceptance criterion, matched by its text. */
export function acceptanceFor(report: Pick<Report, "acceptance"> | null, criterion: string): AcceptanceResult | undefined {
  const want = normalCriterion(criterion);
  const said = (report?.acceptance ?? []).filter((r) => normalCriterion(r.criterion) === want);
  // Reported twice: an unmet entry wins, so a contradiction never reads as met.
  return said.find((r) => !r.met) ?? said[0];
}

/**
 * The task's acceptance criteria its report doesn't show as met: reported
 * unmet, or not reported at all. Empty when there are no criteria.
 */
export function unmetAcceptance(task: Pick<Task, "acceptance" | "report">): string[] {
  return task.acceptance.filter((c) => acceptanceFor(task.report, c)?.met !== true);
}
