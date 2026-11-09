import { isTunable, type PostmortemSettings, type RetentionSettings } from "@crane/contracts";
import type { Store } from "@crane/storage";
import { checkDriver, checkDriverSettings, normalizeDriverSetting } from "../action-inputs.js";

export function configureRetention(store: Store, input: RetentionSettings): RetentionSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected retention settings");
  const days = input.finishedTaskDays;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 36500)) {
    throw new Error("Retention days must be a whole number from 1 to 36500, or null to keep all history");
  }
  store.setSetting("retention_finished_task_days", days === null ? "" : String(days));
  return store.retentionSettings();
}

/**
 * The agent, model, and effort are captured when a merge queues its read-only
 * post-mortem. `crew` names who runs them, and applies to those already waiting;
 * an empty list leaves them to any active member.
 */
export function configurePostmortem(store: Store, input: { driver?: string | null; model?: string | null; effort?: string | null; crew?: string[] }): PostmortemSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected post-mortem settings");
  const saved = store.postmortemSettings();
  const driver = input.driver === undefined ? saved.driver : checkDriver(input.driver);
  const changed = driver !== saved.driver;
  const crew = input.crew === undefined ? saved.crew : checkPostmortemCrew(store, input.crew);
  const next = { driver, model: changed ? null : saved.model, effort: changed ? null : saved.effort, crew };
  if (driver && isTunable(driver)) {
    const tuning = checkDriverSettings(driver, input);
    if (tuning.model !== undefined) next.model = tuning.model || null;
    if (tuning.effort !== undefined) next.effort = tuning.effort || null;
  } else {
    for (const value of [input.model, input.effort]) {
      if (value !== undefined && value !== null && (typeof value !== "string" || normalizeDriverSetting(value))) {
        throw new Error("Choose an agent that calls a model before setting post-mortem model or effort");
      }
    }
    next.model = next.effort = null;
  }
  store.setPostmortemSettings(next);
  return next;
}

function checkPostmortemCrew(store: Store, crew: unknown): string[] {
  if (!Array.isArray(crew)) throw new Error("Choose who runs post-mortems as a list of crew members");
  const members = new Set(store.listAgents().map((a) => a.id));
  for (const id of crew) if (!members.has(id as string)) throw new Error(`No crew member ${String(id)}`);
  return [...new Set(crew as string[])];
}
