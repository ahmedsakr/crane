/** Sunday is bit 0, Saturday bit 6. Times are local to the IANA timezone. */
export interface CrewScheduleInput {
  repoId: string;
  daysMask: number;
  localTime: string;
  timezone: string;
  preApprove: boolean;
  enabled: boolean;
}

export interface CrewSchedule extends CrewScheduleInput {
  id: string;
  agentId: string;
  nextFireAt: string;
  lastFiredAt: string | null;
  lastOutcome: string | null;
}

export function validateCrewSchedule(input: CrewScheduleInput): void {
  if (!input || typeof input !== "object") throw new Error("Choose a schedule");
  if (typeof input.repoId !== "string" || !input.repoId) throw new Error("Choose a repo");
  if (!Number.isInteger(input.daysMask) || input.daysMask < 1 || input.daysMask > 127) throw new Error("Choose at least one day (mask 1–127)");
  if (typeof input.localTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)) throw new Error("Choose a local time in HH:MM format");
  if (typeof input.timezone !== "string" || !input.timezone || /^[+-]/.test(input.timezone)) throw new Error("Choose an IANA timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }); }
  catch { throw new Error("Choose an IANA timezone"); }
  if (typeof input.preApprove !== "boolean" || typeof input.enabled !== "boolean") throw new Error("Pre-approve and enabled must be booleans");
}

/**
 * First slot strictly after `after`. Spring gaps skip that day's slot; autumn
 * folds use the earlier instant once. Calendar days, never 24-hour increments
 * of the previous firing, keep the wall time stable across offset changes.
 */
export function nextCrewFire(input: CrewScheduleInput, after: number): string {
  validateCrewSchedule(input);
  if (!Number.isFinite(after)) throw new Error("Invalid schedule reference time");
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const local = (ms: number) => {
    const parts = format.formatToParts(ms);
    const n = (key: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === key)!.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
  };
  const start = new Date(local(after));
  start.setUTCHours(0, 0, 0, 0);
  const [hour, minute] = input.localTime.split(":").map(Number);
  // Two weeks cover a weekly slot skipped by a DST gap or a date-line shift.
  for (let day = 0; day < 15; day++) {
    const date = new Date(start.getTime() + day * 86_400_000);
    if (!(input.daysMask & (1 << date.getUTCDay()))) continue;
    const wall = date.getTime() + hour! * 3_600_000 + minute! * 60_000;
    const offsets = new Set<number>();
    for (let h = -36; h <= 36; h += 6) {
      const sample = wall + h * 3_600_000;
      offsets.add(local(sample) - sample);
    }
    const candidates = [...offsets].map((offset) => wall - offset).filter((ms) => local(ms) === wall).sort((a, b) => a - b);
    if (candidates[0] !== undefined && candidates[0] > after) return new Date(candidates[0]).toISOString();
  }
  throw new Error("No schedule slot found in the next two weeks");
}

export function crewScheduleLabel(s: Pick<CrewScheduleInput, "daysMask" | "localTime" | "timezone">): string {
  let days: string;
  if (s.daysMask === 62) days = "weekday";
  else if (s.daysMask === 127) days = "daily";
  else days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].filter((_, i) => s.daysMask & (1 << i)).join(", ");
  return `${days} ${s.localTime} (${s.timezone})`;
}
