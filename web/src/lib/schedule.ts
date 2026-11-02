import { nextCrewFire, validateCrewSchedule, type CrewSchedule, type CrewScheduleInput, type Repo } from "@crane/contracts";

/** Format an instant for the browser's date and time inputs: `YYYY-MM-DDTHH:mm`. */
export function localStartTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Null means now; anything else is a local time, which may still be incomplete. */
export function parseStartTime(value: string | null): string | null {
  if (value === null) return null;
  const d = new Date(value);
  if (!value || !Number.isFinite(d.getTime()) || localStartTime(d.toISOString()) !== value) {
    throw new Error("Choose a valid start date and time in your timezone.");
  }
  if (d.getTime() <= Date.now()) throw new Error("Choose a start time in the future.");
  return d.toISOString();
}

/** What's wrong with a start time, for showing as it's chosen rather than on submit. */
export function startProblem(value: string | null): string | null {
  try {
    parseStartTime(value);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export interface StartPreset {
  id: string;
  label: string;
  /** A local time in the same form `parseStartTime` reads. */
  value: string;
}

const QUARTER_HOUR = 15 * 60_000;
const MORNING_HOUR = 9;
const EVENING_HOUR = 21;

function localAt(now: Date, days: number, hour: number): string {
  return localStartTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour).toISOString());
}

/** The default when the operator picks their own time: the next working morning start. */
export function tomorrowMorning(now = new Date()): string {
  return localAt(now, 1, MORNING_HOUR);
}

/**
 * Times people actually mean, in the order they come. Quiet hours and the next
 * morning cover most deferred work, so a custom date is rarely needed. Options
 * that would be too close or repeat another are left out.
 */
export function startPresets(now = new Date(), locale?: string): StartPreset[] {
  const hour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(locale, { hour: "numeric" });
  const soon = Math.ceil((now.getTime() + 3_600_000) / QUARTER_HOUR) * QUARTER_HOUR;
  const presets: StartPreset[] = [{ id: "hour", label: "In 1 hour", value: localStartTime(new Date(soon).toISOString()) }];
  const h = now.getHours();
  // Before 8am the next working start is today; before 8pm tonight is still ahead.
  if (h < 8) presets.push({ id: "morning", label: `This morning ${hour(MORNING_HOUR)}`, value: localAt(now, 0, MORNING_HOUR) });
  else if (h < 20) presets.push({ id: "tonight", label: `Tonight ${hour(EVENING_HOUR)}`, value: localAt(now, 0, EVENING_HOUR) });
  presets.push({ id: "tomorrow", label: `Tomorrow ${hour(MORNING_HOUR)}`, value: tomorrowMorning(now) });
  // From Sunday, Monday is already "Tomorrow".
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday > 1) presets.push({ id: "monday", label: `Monday ${hour(MORNING_HOUR)}`, value: localAt(now, toMonday, MORNING_HOUR) });
  return presets;
}

function dayNumber(ms: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day")) / 86_400_000;
}

/** "Today at 9:00 PM", "Tomorrow at 9:00 AM", or "Mon, Nov 9 at 9:00 AM", on the wall clock of `timeZone`. */
export function whenLabel(ms: number, { timeZone, now = Date.now(), locale }: { timeZone?: string; now?: number; locale?: string } = {}): string {
  const time = new Date(ms).toLocaleTimeString(locale, { timeZone, hour: "numeric", minute: "2-digit" });
  const days = dayNumber(ms, timeZone) - dayNumber(now, timeZone);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  return `${new Date(ms).toLocaleDateString(locale, { timeZone, weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

/** How far off an instant is, in the coarsest unit that's still useful. */
export function untilLabel(ms: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((ms - now) / 60_000));
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `in ${Math.round(hours / 24)} days`;
}

/** A start time in a few words, for collapsed forms. */
export function startSummary(value: string | null): string {
  if (value === null) return "Now";
  return startProblem(value) ? "Later" : whenLabel(new Date(value).getTime());
}

// ── recurring crew schedules ──────────────────────────────

const WEEKDAYS = 0b0111110;
const WEEKENDS = 0b1000001;
const EVERY_DAY = 0b1111111;

export const DAY_PRESETS = [
  { label: "Weekdays", mask: WEEKDAYS },
  { label: "Every day", mask: EVERY_DAY },
  { label: "Weekends", mask: WEEKENDS },
];

/** Monday first, the way work weeks read. `bit` is the day's place in `daysMask`, Sunday being 0. */
export const WEEK = [
  { label: "Mon", bit: 1 },
  { label: "Tue", bit: 2 },
  { label: "Wed", bit: 3 },
  { label: "Thu", bit: 4 },
  { label: "Fri", bit: 5 },
  { label: "Sat", bit: 6 },
  { label: "Sun", bit: 0 },
];

export function daysLabel(mask: number): string {
  return DAY_PRESETS.find((p) => p.mask === mask)?.label ?? WEEK.filter((d) => mask & (1 << d.bit)).map((d) => d.label).join(", ");
}

/** "09:00" as the operator's locale writes it. */
export function timeOfDayLabel(localTime: string, locale?: string): string {
  const [hour, minute] = localTime.split(":").map(Number);
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The soonest slot a member has coming; paused schedules don't count. */
export function nextSchedule(list: CrewSchedule[]): CrewSchedule | null {
  return list.reduce<CrewSchedule | null>(
    (soonest, s) => (s.enabled && (!soonest || Date.parse(s.nextFireAt) < Date.parse(soonest.nextFireAt)) ? s : soonest),
    null,
  );
}

/**
 * A new schedule that's ready to save: weekday mornings where the operator is,
 * on a repo this member doesn't already cover, with Crane's own repo first.
 * Open runs skip the slot, so a second schedule on the same repo is rarely wanted.
 */
export function newScheduleInput(repos: Repo[], existing: Pick<CrewSchedule, "repoId">[], timezone = browserTimezone()): CrewScheduleInput {
  const ordered = [...repos].sort((a, b) => Number(b.isFactory) - Number(a.isFactory));
  const repo = ordered.find((r) => !existing.some((s) => s.repoId === r.id)) ?? ordered[0];
  return { repoId: repo?.id ?? "", daysMask: WEEKDAYS, localTime: "09:00", timezone, preApprove: false, enabled: true };
}

/** What a draft schedule would do next, or why it can't be saved yet. */
export function schedulePreview(input: CrewScheduleInput, now = Date.now(), locale?: string): { next: string } | { problem: string } {
  if (!input.daysMask) return { problem: "Choose at least one day." };
  try {
    validateCrewSchedule(input);
    return { next: whenLabel(Date.parse(nextCrewFire(input, now)), { timeZone: input.timezone, now, locale }) };
  } catch (e) {
    return { problem: `${(e as Error).message}.` };
  }
}
