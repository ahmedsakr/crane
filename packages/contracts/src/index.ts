/** Shared domain/HTTP shapes and pure presentation helpers. No runtime dependencies. */
export { errorMessage } from "./errors.js";
export { runCostLabel, runTokens } from "./run-labels.js";
export { GOAL_TASK_PHASES, goalProgress, goalTaskPhase, validateGoalPlan, goalWaves } from "./goals.js";
export type { Goal, GoalTask, GoalTaskPhase, GoalPlan, GoalProgress, GoalDetail, GoalListItem, GoalSummary, NewGoal } from "./goals.js";
export { nextCrewFire, validateCrewSchedule, crewScheduleLabel } from "./crew-schedules.js";
export type { CrewSchedule, CrewScheduleInput } from "./crew-schedules.js";
export type {
  TaskKind,
  Autonomy,
  TaskStatus,
  PrerequisiteState,
  FollowUpState,
  FollowUpSource,
  TaskGates,
  Task,
  TaskSummary,
  TaskRunOptions,
  NewTask,
  TaskDiff,
  TaskDraft,
} from "./task.js";
export type {
  Finding,
  Report,
  VisualReview,
  AcceptanceResult,
  Screenshot,
  ValidationRun,
  ReviewCheckpoint,
} from "./report.js";
export type {
  Repo,
  RepoTools,
} from "./repo.js";
export type {
  CommandEvidence,
  EventType,
  TaskEvent,
  BlockedCall,
  BlockedTool,
} from "./events.js";
export type {
  AgentState,
  Agent,
  RoleRunOptions,
  MaintenanceRole,
  MaintenanceRoleInfo,
} from "./crew.js";
export type {
  Lookout,
  LookoutInfo,
} from "./lookouts.js";
export type {
  RunKind,
  RunOutcome,
  RunUsage,
  AgentRun,
} from "./runs.js";
export type {
  SpendSlice,
  Analytics,
  Overview,
  TaskDetail,
  RetentionSettings,
} from "./overview.js";
export type {
  DriverName,
  DriverSettings,
  PostmortemSettings,
  DriverInfo,
} from "./drivers.js";
export type {
  MergeOutcome,
} from "./merge.js";
export {
  ACTIVE_STATUSES,
  FINISHED_STATUSES,
  ALL_STATUSES,
  SHIPPED_STATUSES,
  isScheduled,
  UNSHIPPED_STATUSES,
  KIND_LABEL,
  AUTONOMY_LABEL,
  STATUS_LABEL,
  prerequisiteMet,
  followUpFor,
} from "./task.js";
export {
  acceptanceCheckRun,
  acceptanceFor,
  unmetAcceptance,
  visualReviewPending,
  visualReviewWaivedByPreApproval,
  completionReviewReason,
} from "./report.js";
export {
  MAINTENANCE_ROLES,
  isMaintenanceRole,
  MAINTENANCE_ROLE,
} from "./crew.js";
export {
  LOOKOUTS,
  LOOKOUT,
  isLookout,
  lookoutsLabel,
} from "./lookouts.js";
export {
  RUN_KIND_LABEL,
} from "./runs.js";
export {
  DRIVER_NAMES,
  DRIVER_LABEL,
  isDriverName,
  driverLabel,
  EFFORT_LEVELS,
  MODEL_SUGGESTIONS,
  isTunable,
  settingsLabel,
  choosableDrivers,
} from "./drivers.js";
export {
  lastMergeOutcome,
} from "./merge.js";
export type { DiffLine, DiffHunk, DiffFile, ParsedDiff, SplitRow } from "./diff.js";
export { parseDiff, diffFiles, splitRows } from "./diff.js";
export { ruleLabel } from "./rules.js";
