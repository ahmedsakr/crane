/** What the site's legend, tooltip and accessible label say. Pure: no DOM and no React. */
import type { Overview, TaskStatus, TaskSummary } from "@crane/contracts";
import { ZONE_IDS, ZONE_LABEL, ZONE_OF, type ZoneId } from "./zones.js";

/** Every task the overview mentions, once. */
export function siteTasks(o: Pick<Overview, "inFlight" | "needsReview" | "recent">): TaskSummary[] {
  const seen = new Map<string, TaskSummary>();
  for (const t of [...o.inFlight, ...o.needsReview, ...o.recent]) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()];
}

export function zoneCounts(tasks: { status: TaskStatus }[]): Record<ZoneId, number> {
  const counts = Object.fromEntries(ZONE_IDS.map((z) => [z, 0])) as Record<ZoneId, number>;
  for (const t of tasks) counts[ZONE_OF[t.status]]++;
  return counts;
}

export function zoneSummary(counts: Record<ZoneId, number>): string {
  return ZONE_IDS.filter((z) => counts[z]).map((z) => `${ZONE_LABEL[z]}: ${counts[z]}`).join(", ");
}
