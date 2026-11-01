/**
 * Crane's shared domain model and HTTP response shapes.
 *
 * The operator (a human) issues Tasks. Agents pick tasks up and work them
 * inside a target Repo. What comes back is a stream of Events and, at the end,
 * a Report with Findings. Anything that would change code is held behind the
 * task's autonomy level so the operator stays in control.
 */

/** What kind of work a task is. */
export type TaskKind =
  /** Keep an existing codebase healthy: bugs, flaky tests, deps, security, cleanup. */
  | "maintenance"
  /** Research or build a new capability into a target repo. */
  | "repo_feature"
  /** Research or build a new capability into Crane itself. */
  | "factory_feature";

/**
 * How far an agent may go on its own.
 * - observe: read-only. Investigates and reports back.
 * - propose: makes changes on an isolated branch, then waits for the operator.
 * - act: makes changes on an isolated branch and finishes without waiting.
 * Crane never pushes or merges into a default branch on its own. That only
 * happens when the operator approves and merges a task (see `merging`).
 */
export type Autonomy = "observe" | "propose" | "act";

export type TaskStatus =
  | "queued"
  | "running"
  | "needs_review"
  | "approved"
  /** Approved and waiting for, or in the middle of, landing on the default branch. */
  | "merging"
  /** Landed on the default branch (and pushed, when the repo has a remote). */
  | "merged"
  | "rejected"
  | "done"
  | "failed"
  | "cancelled";

/** Statuses where something is waiting to run or running: an agent's work, or a merge. */
export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "merging"];
/** Statuses where the work is over. Nothing more runs unless the operator merges or retries it. */
export const FINISHED_STATUSES: TaskStatus[] = ["approved", "merged", "rejected", "done", "failed", "cancelled"];
export const ALL_STATUSES: TaskStatus[] = [
  "queued",
  "running",
  "needs_review",
  "approved",
  "merging",
  "merged",
  "rejected",
  "done",
  "failed",
  "cancelled",
];
/** Statuses that count as shipped work. */
export const SHIPPED_STATUSES: TaskStatus[] = ["done", "approved", "merged"];

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  /** True for the repo Crane itself lives in, used for factory_feature tasks. */
  isFactory: boolean;
  addedAt: string;
}

export interface Finding {
  title: string;
  detail: string;
  /** How much this matters, from the agent's point of view. */
  impact: "low" | "medium" | "high";
  /** Rough size of the work to act on it. */
  effort: "small" | "medium" | "large";
}

export interface Report {
  /** Factory-owned evidence; never accepted from agent output. */
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

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
  status: TaskStatus;
  agentId: string | null;
  branch: string | null;
  worktree: string | null;
  /**
   * The agent's own session for this task, recorded as soon as it starts. If
   * the factory restarts mid-task, the next agent picks this session up again
   * instead of starting over.
   */
  sessionId: string | null;
  /**
   * The agent the operator chose for this task, e.g. `codex`. Null means the
   * factory's default agent at the time it's picked up.
   */
  driver: string | null;
  /** Task overrides; null follows the chosen agent's saved settings. */
  model: string | null;
  effort: string | null;
  /** Saved overrides for an automatic post-mortem. Null follows the agent's settings. */
  driverSettings: DriverSettings | null;
  /**
   * The crew member this task is for, e.g. `a-jib`, when the operator started
   * it from that member's maintenance role. Only that member picks it up.
   * Null means whoever is free next.
   */
  assignee: string | null;
  /**
   * When the operator pre-approved this task, before it reached review. Once
   * its run finishes and its checks pass, it goes straight to the merge queue
   * instead of waiting for them. Null means it waits for review as usual.
   */
  preApprovedAt: string | null;
  /**
   * Tasks that must land first (see `prerequisiteMet`). Crane doesn't start
   * this one until they have, unless the operator waives them.
   */
  prerequisites: string[];
  /**
   * When the operator waived the prerequisites that hadn't landed, approving a
   * reduced scope so the task could start without them. Null if never waived.
   */
  prerequisitesWaivedAt: string | null;
  /**
   * Observable conditions the work must meet. A pre-approved task merges on
   * its own only when its report shows every one of them met.
   */
  acceptance: string[];
  /**
   * Opportunities the operator asked the agent to also look out for while it
   * works the task (see `LOOKOUT`). They don't widen the task: the agent
   * reports what it finds as findings. Empty when none were asked for.
   */
  lookouts: Lookout[];
  report: Report | null;
  costUsd: number;
  createdAt: string;
  /** Earliest pickup time, in UTC. Null means immediately eligible; prerequisites still apply. */
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type EventType =
  | "status" // lifecycle change
  | "note" // the agent's narration
  | "tool" // the agent used a tool
  | "finding" // something worth the operator's attention
  | "error"
  | "blocked" // a tool call the agent's permissions refused; data is a BlockedCall
  | "operator"; // something the operator did

export interface TaskEvent {
  id: number;
  taskId: string;
  ts: string;
  type: EventType;
  message: string;
  data: Record<string, unknown> | null;
}

/** What a `blocked` event carries: the refused call, evidence, and suggested rules. */
export interface BlockedCall {
  tool: string;
  /** Driver call id, for correlating live refusals with end-of-run records. */
  toolUseId?: string;
  /**
   * Driver evidence, not a policy decision inferred from rule suggestions.
   * Optional for older events and drivers without refusal evidence.
   */
  refusal?: {
    source: "claude-code.tool_result" | "claude-code.permission_denials";
    /** Driver-reported refusal text (bounded); null when no reason was supplied. */
    reason: string | null;
  };
  /** The Bash command, when the tool was Bash. */
  command?: string;
  /**
   * Suggested permission rules (e.g. `Bash(npm ci:*)`) for operator review.
   * Empty when it was refused on purpose (ALWAYS_DENIED, or a write in an
   * investigate-only task) or Crane has nothing safe to suggest. These are
   * heuristic suggestions, not the driver's decision reason or a guarantee
   * that granting them will resolve a refusal. An empty list explains nothing
   * about which policy refused the call.
   */
  rules: string[];
}

/**
 * A rule an agent was refused in one repo, added up across its tasks, so the
 * operator can allow it once instead of rediscovering it in every task.
 */
export interface BlockedTool {
  repoId: string;
  repoName: string;
  /** The permission rule to allow, e.g. `Bash(npm ci:*)`. */
  rule: string;
  /** What the operator reads: `npm ci`. */
  label: string;
  /** How many tasks hit it, and how many times in all. */
  tasks: number;
  times: number;
  lastAt: string;
  /** The most recent task that hit it. */
  lastTaskId: string;
}

/** Tool rules the operator has decided on for one repo. */
export interface RepoTools {
  /** Allowed for every agent working in this repo, on top of Crane's defaults. */
  allowed: string[];
  /** Blocked rules the operator chose to keep blocked, so Crane stops asking. */
  keptBlocked: string[];
}

export type AgentState = "idle" | "working" | "paused";

export interface Agent {
  active: boolean;
  defaultDriver: string | null;
  /**
   * The maintenance this member is dedicated to, or null for a general member.
   * A member with a role works only the runs the operator starts for it.
   */
  role: MaintenanceRole | null;
  id: string;
  name: string;
  state: AgentState;
  taskId: string | null;
  driver: string;
  tasksCompleted: number;
  lastActiveAt: string | null;
}

export interface TaskRunOptions {
  /** Which agent works it. Null uses the factory's default. */
  driver?: string | null;
  /** Overrides for this task only; null follows the agent's saved settings. */
  model?: string | null;
  effort?: string | null;
}

export interface NewTask extends TaskRunOptions {
  kind: TaskKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
  /** Earliest pickup time: a future ISO 8601 timestamp with a timezone, or null for now. */
  scheduledAt?: string | null;
  /** The crew member who must work it. Leave out for whoever is free next. */
  assignee?: string | null;
  /** Ids of tasks in the same repo that must land before this one starts. */
  prerequisites?: string[];
  /** Observable conditions the work must meet before it can merge without review. */
  acceptance?: string[];
  /** What else the agent should look out for while it works. */
  lookouts?: Lookout[];
}

/** A queued task still waiting for its start time. Due tasks read as queued again. */
export const isScheduled = (task: Pick<Task, "status" | "scheduledAt">, now = Date.now()): boolean =>
  task.status === "queued" && task.scheduledAt != null && Date.parse(task.scheduledAt) > now;

/** What a follow-up can add to the run options: the gates it must pass. */
export type TaskGates = Pick<NewTask, "prerequisites" | "acceptance">;

/** Opportunities an agent can be asked to look out for alongside its task. */
export const LOOKOUTS = ["refactoring", "improvements", "test_gaps"] as const;
export type Lookout = (typeof LOOKOUTS)[number];

export const isLookout = (name: unknown): name is Lookout =>
  typeof name === "string" && (LOOKOUTS as readonly string[]).includes(name);

export interface LookoutInfo {
  /** What the operator turns on: "Test gaps". */
  label: string;
  /** One line on what the agent looks for. */
  hint: string;
  /** What the agent is asked to look out for, as one item of a list. */
  brief: string;
}

export const LOOKOUT: Record<Lookout, LookoutInfo> = {
  refactoring: {
    label: "Refactoring",
    hint: "Duplicated, tangled, or unclear code near the change.",
    brief: "Refactoring: duplicated logic, functions doing too much, unclear names, dead code, and needless complexity in and around the code you work in.",
  },
  improvements: {
    label: "Improvements",
    hint: "Latent bugs, error handling, performance, rough edges.",
    brief: "Improvements: latent bugs, missing or weak error handling, performance problems, and rough edges in and around the code you work in.",
  },
  test_gaps: {
    label: "Test gaps",
    hint: "Behaviour with no tests, and tests that check too little.",
    brief: "Test coverage gaps: important behaviour with no tests, tests that assert too little, and flaky tests, starting with the code your task touches.",
  },
};

/** "Refactoring, test gaps", or null when the task asks for none. */
export function lookoutsLabel(lookouts: readonly Lookout[] | undefined): string | null {
  if (!lookouts?.length) return null;
  return lookouts.map((l, i) => (i ? LOOKOUT[l].label.toLowerCase() : LOOKOUT[l].label)).join(", ");
}

/**
 * Whether a prerequisite has landed: merged into the default branch, or
 * finished without a branch, so there's nothing of it left to merge.
 * Approved or done with a branch kept isn't landed yet.
 */
export const prerequisiteMet = (t: Pick<Task, "status" | "branch">): boolean =>
  t.status === "merged" || ((t.status === "done" || t.status === "approved") && !t.branch);

/** A prerequisite as a task's page and CLI show it. */
export interface PrerequisiteState extends Pick<Task, "id" | "title" | "status"> {
  met: boolean;
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

/** Kinds of maintenance a crew member can be dedicated to. */
export const MAINTENANCE_ROLES = [
  "code_quality",
  "duplication",
  "packaging",
  "best_practices",
  "security",
  "tests",
] as const;
export type MaintenanceRole = (typeof MAINTENANCE_ROLES)[number];

export const isMaintenanceRole = (name: unknown): name is MaintenanceRole =>
  typeof name === "string" && (MAINTENANCE_ROLES as readonly string[]).includes(name);

export interface MaintenanceRoleInfo {
  /** What the operator assigns: "Security review". */
  label: string;
  /** What starting a run does, as a plain verb: "Review security". Also the task's title. */
  action: string;
  /** One line on what the member looks for. */
  summary: string;
  /** How far a run may go. Findings from investigate-only runs become follow-ups the operator starts. */
  autonomy: Autonomy;
  /** What the agent is asked to do. */
  brief: string;
}

const ROLE_SCOPE =
  "Survey the whole codebase first, then pick the few changes worth the most for their size. Keep the change small enough to review in one sitting, and report everything else you found as findings, most valuable first.";

export const MAINTENANCE_ROLE: Record<MaintenanceRole, MaintenanceRoleInfo> = {
  code_quality: {
    label: "Code quality",
    action: "Improve code quality",
    summary: "Readability, dead code, tangled functions, unclear names.",
    autonomy: "propose",
    brief: `Improve code quality. Look for dead code, functions doing too much, unclear names, misleading comments, and needless complexity. Don't change behaviour. ${ROLE_SCOPE}`,
  },
  duplication: {
    label: "Duplication",
    action: "Reduce duplication",
    summary: "Repeated logic that should live in one place.",
    autonomy: "propose",
    brief: `Reduce duplication. Find logic, types, and constants repeated across files, and fold the clearest cases into one shared place. Leave look-alike code alone when the copies are likely to diverge. Don't change behaviour. ${ROLE_SCOPE}`,
  },
  packaging: {
    label: "Packaging",
    action: "Review packaging",
    summary: "Module boundaries, and parts that could be shared as packages.",
    autonomy: "observe",
    brief: `Review packaging and modularity, so parts of this codebase are easier to share and reuse. Map the module boundaries and dependencies between them, find parts that could stand alone as packages or libraries, and note what holds them back (circular imports, leaked internals, missing entry points or exports, build setup). Actively propose new packages to create for better modularity, including internal workspace packages, even where the code does not yet form a standalone module. Ground each proposal in the codebase's needs: describe its responsibility, public API, intended consumers, dependency boundaries, and how it would reduce coupling or enable reuse. Weigh those benefits against the added build and maintenance cost, and avoid speculative packages with no clear consumer. Recommend concrete steps in order, including how to introduce each worthwhile package and move existing callers to it. ${ROLE_SCOPE}`,
  },
  best_practices: {
    label: "Best practices",
    action: "Apply best practices",
    summary: "Idioms, error handling, types, and conventions for this stack.",
    autonomy: "propose",
    brief: `Bring the code in line with best practices for its language and frameworks, and with the conventions this repo already documents. Look at error handling, typing, resource cleanup, async use, configuration, and logging. Prefer the repo's own established patterns over outside ones. ${ROLE_SCOPE}`,
  },
  security: {
    label: "Security review",
    action: "Review security",
    summary: "Injection, secrets, unsafe defaults, permission gaps.",
    autonomy: "observe",
    brief: `Review security. Look for injection (shell, SQL, path), unvalidated input at trust boundaries, secrets in code or logs, unsafe defaults, missing permission checks, and risky dependencies. For each finding, say how it could be exploited and how to fix it, and rate impact by real-world risk. Don't run exploits or anything that reaches outside this machine. ${ROLE_SCOPE}`,
  },
  tests: {
    label: "Tests",
    action: "Strengthen tests",
    summary: "Untested paths, flaky or weak tests.",
    autonomy: "propose",
    brief: `Strengthen the test suite. Find important behaviour with no tests, tests that assert too little, and flaky ones. Add or fix tests for the riskiest gaps, matching the repo's existing test style, and make sure the suite passes. ${ROLE_SCOPE}`,
  },
};

/** Why an agent ran: to work the task itself, or to resolve a merge's conflicts. */
export type RunKind = "work" | "resolve_conflicts";
export type RunOutcome = "running" | "succeeded" | "failed" | "cancelled";

/** What one agent run used, as its driver reported it. */
export interface RunUsage {
  /**
   * The driver's own figure, at API prices. On a subscription it's an estimate,
   * not a bill. The known subtotal when costStatus is unknown.
   */
  costUsd: number;
  /** Omitted by drivers that report their own cost. Unknown can include a known subtotal. */
  costStatus?: "reported" | "estimated" | "unknown";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  /** The model that did most of the work, when the driver knows. */
  model: string | null;
}

/**
 * One agent run against a task. A task can have several: a run per attempt
 * (a factory restart re-runs it) plus any conflict resolution while merging.
 * The task's `costUsd` is the sum of its runs.
 */
export interface AgentRun extends RunUsage {
  id: number;
  taskId: string;
  kind: RunKind;
  agentId: string | null;
  driver: string;
  outcome: RunOutcome;
  startedAt: string;
  finishedAt: string | null;
}

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  work: "Work",
  resolve_conflicts: "Resolve conflicts",
};

/** Statuses where the work was thrown away, so what it cost bought nothing that shipped. */
export const UNSHIPPED_STATUSES: TaskStatus[] = ["failed", "cancelled", "rejected"];

export interface SpendSlice {
  usd: number;
  tasks: number;
}

/** Spend over a window of days, attributed to when each run finished. */
export interface Analytics {
  days: number;
  from: string;
  to: string;
  spendUsd: number;
  /** Runs whose cost is missing in whole or in part; excluded amounts are not free. */
  unknownCostRuns: number;
  /** The same number of days just before `from`. */
  prevSpendUsd: number;
  runs: number;
  /** Tasks with at least one run in the window. */
  tasks: number;
  /** Tasks that were done, approved, or merged. */
  shipped: SpendSlice;
  /** Tasks that failed, were cancelled, or were declined. */
  unshipped: SpendSlice;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** One bucket per local day, oldest first. `day` is the local midnight it starts at. */
  daily: { day: string; usd: number; runs: number }[];
  byRepo: (SpendSlice & { repoId: string | null; name: string })[];
  byKind: (SpendSlice & { kind: TaskKind })[];
  /** Per-run driver attribution; a task can count under more than one agent. Includes zero-cost runs. */
  byAgent: (SpendSlice & { driver: string })[];
  /** The most expensive tasks in the window, by what they cost in it. */
  topTasks: (Pick<Task, "id" | "title" | "status" | "kind" | "repoId"> & { usd: number; runs: number })[];
}

export interface Overview {
  factory: {
    running: boolean;
    paused: boolean;
    driver: string;
    /** The running backend is older than its source; rebuild and restart the factory to load changes. */
    factoryOutdated: boolean;
    /** The served dashboard is older than its source, so recent UI changes won't show until a rebuild. */
    uiOutdated: boolean;
    /** Identifies the dashboard being served. When it changes, a newer build has replaced it. */
    uiBuild: string | null;
    /** The commit Crane built the served dashboard from, or null when it's the checkout's own web/dist. */
    uiCommit: string | null;
  };
  counts: Record<TaskStatus, number>;
  /** Unassigned queued tasks whose start time has arrived; not capped by inFlight. */
  queuedForAnyone: number;
  shippedThisWeek: number;
  shippedLastWeek: number;
  spendThisWeekUsd: number;
  /** One bucket per hour for the last 7 days: completed tasks and agent events. */
  activity: { t: string; done: number; events: number }[];
  needsReview: Task[];
  inFlight: Task[];
  recent: Task[];
  agents: Agent[];
  repos: (Repo & { openTasks: number; tools: RepoTools })[];
  /** Commands agents keep getting refused, in more than one task, that the operator hasn't decided on yet. */
  blocked: BlockedTool[];
}

/** One task with everything its page shows: `GET /api/tasks/:id`. */
export interface TaskDetail {
  task: Task;
  repo: Repo | null;
  /** Who's working it, or, before it's picked up, the crew member it was started for. */
  agent: Agent | null;
  events: TaskEvent[];
  runs: AgentRun[];
  /** Commands this task was blocked from that still wait on a decision, counted across the repo. */
  blocked: BlockedTool[];
  /** The task's prerequisites, in the order it lists them, and whether each has landed. */
  prerequisites: PrerequisiteState[];
}

/** What a task changed: `GET /api/tasks/:id/diff`. */
export interface TaskDiff {
  /** A unified diff against the default branch, or "" when there's nothing to show. */
  diff: string;
  /** True while the task runs: the diff is read from its worktree, uncommitted work included, and keeps changing. */
  live: boolean;
}

/** Crane's reading of a plain-language instruction: `POST /api/instruct/draft`. */
export interface TaskDraft {
  kind: TaskKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
  /** Short reasons for each guess, shown to the operator so they can correct them. */
  why: { kind: string; repo: string; autonomy: string };
}

/** The agents Crane can run tasks on. Each one is a driver in `src/agents/`. */
export const DRIVER_NAMES = ["claude-code", "codex", "simulated"] as const;
export type DriverName = (typeof DRIVER_NAMES)[number];

export const DRIVER_LABEL: Record<DriverName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  simulated: "Simulated",
};

export const isDriverName = (name: unknown): name is DriverName =>
  typeof name === "string" && (DRIVER_NAMES as readonly string[]).includes(name);

/** A driver's label, or its raw name when Crane doesn't know it (old runs say "unknown"). */
export const driverLabel = (name: string | null | undefined): string =>
  isDriverName(name) ? DRIVER_LABEL[name] : (name ?? "—");

/**
 * The effort levels each agent's CLI accepts, lowest first: `claude --effort`
 * and Codex's `model_reasoning_effort`. Empty means the agent has no model to
 * tune (simulated).
 */
export const EFFORT_LEVELS: Record<DriverName, readonly string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  simulated: [],
};

/** Model names worth suggesting. Any model the agent's CLI accepts works. */
export const MODEL_SUGGESTIONS: Record<DriverName, readonly string[]> = {
  "claude-code": ["fable", "opus", "sonnet", "haiku"],
  codex: [],
  simulated: [],
};

/** Whether an agent calls a model, so its model and effort can be set. */
export const isTunable = (name: DriverName): boolean => EFFORT_LEVELS[name].length > 0;

/** The model and effort the operator chose for one agent. Null follows the agent's own default. */
export interface DriverSettings {
  model: string | null;
  effort: string | null;
}

/** Defaults for newly queued post-mortems. A null driver keeps the merged task's choice. */
export interface PostmortemSettings extends DriverSettings {
  driver: DriverName | null;
}

/** One agent the operator can choose, and whether this machine can run it. */
export interface DriverInfo extends DriverSettings {
  name: DriverName;
  label: string;
  /** Its CLI is installed and answers, or it needs nothing installed (simulated). */
  available: boolean;
  /** What it is, or how to install it when it isn't. */
  hint: string;
  /** New tasks run on it unless the operator picks another. */
  isDefault: boolean;
  /** Effort levels it accepts, lowest first. Empty when there's no model to tune. */
  efforts: readonly string[];
  /** Model names to suggest. */
  models: readonly string[];
}

/** "opus · high effort", or null when both follow the agent's default. */
export function settingsLabel(s: DriverSettings): string | null {
  const parts = [s.model, s.effort ? `${s.effort} effort` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The agents worth offering when the operator starts a task: installed ones,
 * and Simulated only when it's already the default (a demo). With one or none,
 * there's no choice to show.
 */
export function choosableDrivers(list: DriverInfo[]): DriverInfo[] {
  return list.filter((d) => d.available && (d.name !== "simulated" || d.isDefault));
}

export const KIND_LABEL: Record<TaskKind, string> = {
  maintenance: "Maintenance",
  repo_feature: "Repo feature",
  factory_feature: "Factory feature",
};

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  observe: "Investigate only",
  propose: "Change, then ask me",
  act: "Change on a branch",
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  needs_review: "Needs you",
  approved: "Approved",
  merging: "Merging",
  merged: "Merged",
  rejected: "Declined",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * What the last merge attempt left behind, carried on its status event so the
 * UI and CLI can explain it. A failed attempt sends the task back to the
 * operator with `error` set.
 */
export interface MergeOutcome {
  error?: string;
  /** The commit that landed on the default branch. */
  commit?: string;
  /** The remote it was pushed to, or null when the repo has none. */
  pushedTo?: string | null;
  /** A checkout of the default branch Crane left alone (it had local changes), so the operator can catch up. */
  checkoutBehind?: string | null;
}

/** The merge outcome on the task's latest status event, if that status came from a merge. */
export function lastMergeOutcome(events: TaskEvent[]): MergeOutcome | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "status") return (e.data?.merge as MergeOutcome | undefined) ?? null;
  }
  return null;
}
