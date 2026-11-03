/** A short, readable duration for the activity feed: "0.4s", "12s", "2m 41s". */
export function elapsed(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];
