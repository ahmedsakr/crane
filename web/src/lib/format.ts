export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** How far off a future time is, in `ago`'s units: "in 29d". A time already past is "now". */
export function until(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

export function duration(from: string | null, to: string | null): string {
  if (!from) return "—";
  const s = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function hourLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric" });
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString([], { weekday: "short" })}, ${time}`;
}

export function usd(n: number): string {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** 1,284 / 12.9K / 4.2M */
export function compact(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function plural(n: number, one: string, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}
