/** Crew members and their maintenance responsibilities. */
import type { Autonomy } from "./task.js";

export type AgentState = "idle" | "working" | "paused";

export interface Agent {
  active: boolean;
  defaultDriver: string | null;
  /**
   * The maintenance this member is dedicated to, or null for a general member.
   * A member with a role works only the runs the operator starts for it.
   */
  role: MaintenanceRole | null;
  /** The operator named this member to run post-mortems, whether active or on-call. */
  runsPostmortems: boolean;
  id: string;
  name: string;
  state: AgentState;
  taskId: string | null;
  driver: string;
  tasksCompleted: number;
  lastActiveAt: string | null;
}

/** Options for a crew member's maintenance run. */
export interface RoleRunOptions {
  /** Connected repo id or name; omitted means Crane's own repo. */
  repoId?: string;
  /** Earliest pickup time, or null for now. */
  scheduledAt?: string | null;
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
