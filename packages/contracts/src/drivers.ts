/** Driver identities, settings and presentation helpers. */

/** The agents Crane can run tasks on. Each one is a driver in `@crane/agent-drivers`. */
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
  /**
   * The crew members who run post-mortems, active or on-call, and the only ones
   * who do. Empty leaves them to any active member. Unlike the agent, model, and
   * effort, this is read at pickup, so a change reaches reviews already waiting.
   */
  crew: string[];
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
