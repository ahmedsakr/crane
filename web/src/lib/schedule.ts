/** Format an instant for the browser's datetime-local input. */
export function localStartTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Null means now; an empty string means later, with no time chosen yet. */
export function parseStartTime(value: string | null): string | null {
  if (value === null) return null;
  const d = new Date(value);
  if (!value || !Number.isFinite(d.getTime()) || localStartTime(d.toISOString()) !== value) {
    throw new Error("Choose a valid start date and time in your timezone.");
  }
  if (d.getTime() <= Date.now()) throw new Error("Choose a start time in the future.");
  return d.toISOString();
}
