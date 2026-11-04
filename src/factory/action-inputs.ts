import {
  DRIVER_NAMES,
  EFFORT_LEVELS,
  LOOKOUTS,
  MAINTENANCE_ROLES,
  driverLabel,
  isDriverName,
  isMaintenanceRole,
  isTunable,
  type DriverName,
  type DriverSettings,
  type Lookout,
  type MaintenanceRole,
  type TaskRunOptions,
} from "@crane/contracts";

/**
 * Accept what an operator would type: a rule (`Bash(npm ci:*)`, `WebFetch`)
 * or just a command (`npm ci`), which allows that command and its arguments.
 */
export function toRule(input: string): string {
  const s = input.trim().replace(/^`|`$/g, "");
  if (/^(mcp__[\w-]+|[A-Z][\w-]*)(\(.+\))?$/.test(s)) return s;
  return `Bash(${s.replace(/:\*$/, "")}:*)`;
}

/** What model names look like: `opus`, `claude-opus-5-5[1m]`, `gpt-5-codex`, `us.anthropic.claude-…:0`. */
const MODEL_NAME = /^[A-Za-z0-9][\w.:/@[\]-]{0,119}$/;

/** An agent name the operator typed or sent, checked. Null and "default" mean the factory's default. */
export function checkDriver(name: string | null | undefined): DriverName | null {
  if (name === undefined || name === null || name === "" || name === "default") return null;
  if (!isDriverName(name)) throw new Error(`Unknown agent “${name}”. Use one of: ${DRIVER_NAMES.join(", ")}`);
  return name;
}

/** A maintenance role the operator typed or sent, checked. Null, "" and "none" clear it. */
export function checkRole(name: string | null | undefined): MaintenanceRole | null {
  if (name === undefined || name === null || name === "" || name === "none") return null;
  const key = name.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!isMaintenanceRole(key)) throw new Error(`Unknown maintenance role “${name}”. Use one of: ${MAINTENANCE_ROLES.join(", ")}, or none`);
  return key;
}

/** Null, blank text and "default" clear a driver setting. */
export function normalizeDriverSetting(value: string | null): string {
  const text = value?.trim() ?? "";
  return text === "default" ? "" : text;
}

/** Shared validation for saved preferences and task overrides, before any writes. */
export function checkDriverSettings(driver: DriverName, input: Partial<DriverSettings>): Partial<DriverSettings> {
  if (!isTunable(driver)) throw new Error(`${driverLabel(driver)} doesn't call a model, so there's no model or effort to set`);
  const settings: Partial<DriverSettings> = {};
  if (input.model !== undefined) {
    if (input.model !== null && typeof input.model !== "string") throw new Error("Model must be text");
    const model = normalizeDriverSetting(input.model);
    if (model && !MODEL_NAME.test(model)) throw new Error(`“${model}” doesn't look like a model name`);
    settings.model = model || null;
  }
  if (input.effort !== undefined) {
    if (input.effort !== null && typeof input.effort !== "string") throw new Error("Effort must be text");
    const effort = normalizeDriverSetting(input.effort).toLowerCase();
    const levels = EFFORT_LEVELS[driver];
    if (effort && !levels.includes(effort)) {
      throw new Error(`${driverLabel(driver)} takes effort ${levels.join(", ")}, or default`);
    }
    settings.effort = effort || null;
  }
  return settings;
}

/** The most prerequisites or acceptance criteria one task can have. */
export const MAX_GATES = 20;

/** Require an unambiguous future instant; save UTC so SQLite can compare timestamps. */
export function checkScheduledAt(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const match = typeof input === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(input)
    : null;
  if (!match) throw new Error("Start time must be an ISO 8601 timestamp with a timezone, like 2030-06-15T09:00:00-04:00");
  const [, year, month, day, hour, minute, second] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const time = Date.parse(input as string);
  if (!Number.isFinite(time) || Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days
    || Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) {
    throw new Error("Start time must be a valid date and time");
  }
  if (time <= Date.now()) throw new Error("Choose a start time in the future");
  const utc = new Date(time).toISOString();
  if (utc.length !== 24) throw new Error("Start time must have a four-digit UTC year");
  return utc;
}

/** Acceptance criteria the operator gave, one per entry, trimmed. Blank entries are dropped. */
export function checkAcceptance(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((c) => typeof c !== "string")) throw new Error("Acceptance criteria must be a list of text");
  const criteria = [...new Set(input.map((c: string) => c.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (criteria.length > MAX_GATES) throw new Error(`Give at most ${MAX_GATES} acceptance criteria`);
  if (criteria.some((c) => c.length > 500)) throw new Error("Keep each acceptance criterion under 500 characters");
  return criteria;
}

/**
 * Repo checks a task requires, by exact command. Crane only ever runs the
 * configured ones, so anything else could never be met.
 */
export function checkAcceptanceChecks(input: unknown, configured: string[]): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((c) => typeof c !== "string")) throw new Error("Acceptance checks must be a list of commands");
  const commands = [...new Set(input.map((c: string) => c.trim()).filter(Boolean))];
  const unknown = commands.find((c) => !configured.includes(c));
  if (unknown) throw new Error(`“${unknown}” isn't one of this repo's checks, so Crane would never run it. Add it to the repo's checks, or make it an acceptance criterion`);
  return commands;
}

/**
 * What else the agent should look out for, by name. Takes `test-gaps` as well
 * as `test_gaps`, drops repeats, and keeps Crane's own order.
 */
export function checkLookouts(input: unknown): Lookout[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((l) => typeof l !== "string")) throw new Error("Lookouts must be a list of names");
  const given = new Set(input.map((l: string) => l.trim().toLowerCase().replace(/[-\s]+/g, "_")).filter(Boolean));
  const unknown = [...given].filter((l) => !(LOOKOUTS as readonly string[]).includes(l));
  if (unknown.length) throw new Error(`Crane can't look out for “${unknown[0]}”. Choose from ${LOOKOUTS.join(", ")}`);
  return LOOKOUTS.filter((l) => given.has(l));
}

export function checkTaskRunOptions(input: TaskRunOptions): TaskRunOptions {
  const driver = checkDriver(input.driver);
  // Untuned tasks may follow the default agent, which can change before pickup.
  if (input.model == null && input.effort == null) return { driver, model: null, effort: null };
  if (!driver) throw new Error("Choose an agent before setting a task's model or effort");
  return { driver, ...checkDriverSettings(driver, input) };
}

export type TaskRun = { driver: string | null; model: string | null; effort: string | null };

/**
 * What a run uses after the operator's changes, checked. A field left out stays
 * as it was, except that a model and effort belong to their agent: switching
 * agents clears them unless the operator gave new ones.
 */
export function nextRun(current: TaskRun, input: TaskRunOptions): TaskRun {
  if (input.driver === undefined && input.model === undefined && input.effort === undefined) {
    return { driver: current.driver, model: current.model, effort: current.effort };
  }
  const driver = input.driver === undefined ? current.driver : checkDriver(input.driver);
  const kept = driver === current.driver ? current : { model: null, effort: null };
  const run = checkTaskRunOptions({
    driver,
    model: input.model === undefined ? kept.model : input.model,
    effort: input.effort === undefined ? kept.effort : input.effort,
  });
  return { driver: run.driver ?? null, model: run.model ?? null, effort: run.effort ?? null };
}
