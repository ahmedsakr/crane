import type Database from "better-sqlite3";
import { ALL_STATUSES, FINISHED_STATUSES, SHIPPED_STATUSES, type Overview, type TaskStatus } from "@crane/contracts";
import type { Store } from "../store.js";
import type { Row } from "./rows.js";

const WEEK_MS = 7 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const shippedIn = SHIPPED_STATUSES.map((s) => `'${s}'`).join(",");
const iso = (ms: number) => new Date(ms).toISOString();
const hourOf = (ms: number) => iso(ms).slice(0, 13);

function statusCounts(db: Database.Database): Overview["counts"] {
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Overview["counts"];
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as Row[]) {
    counts[r.status as TaskStatus] = r.n as number;
  }
  return counts;
}

function shippedCount(db: Database.Database, from: number, to: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE status IN (${shippedIn}) AND finished_at >= ? AND finished_at < ?`,
  ).get(iso(from), iso(to)) as Row).n as number;
}

/** Counted when the money was spent, not when the task was created. */
function weeklySpend(db: Database.Database, t0: number): number {
  return (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE outcome != 'running' AND finished_at >= ?")
    .get(iso(t0 - WEEK_MS)) as Row).s as number;
}

function hourlyActivity(db: Database.Database, t0: number): Overview["activity"] {
  const start = Math.floor((t0 - WEEK_MS) / HOUR_MS) * HOUR_MS;
  // Stored times are UTC toISOString(), so the first 13 characters name an hour in SQL as well as here.
  const buckets = new Map<string, Overview["activity"][number]>();
  for (let t = start; t <= t0; t += HOUR_MS) buckets.set(hourOf(t), { t: iso(t), done: 0, events: 0 });
  for (const r of db.prepare(
    "SELECT substr(ts, 1, 13) AS hour, COUNT(*) AS n FROM events WHERE ts >= ? AND type IN ('note','tool','finding') GROUP BY hour",
  ).all(iso(start)) as Row[]) {
    const bucket = buckets.get(r.hour as string);
    if (bucket) bucket.events = r.n as number;
  }
  for (const r of db.prepare(
    `SELECT substr(finished_at, 1, 13) AS hour, COUNT(*) AS n FROM tasks WHERE status IN (${shippedIn}) AND finished_at >= ? GROUP BY hour`,
  ).all(iso(start)) as Row[]) {
    const bucket = buckets.get(r.hour as string);
    if (bucket) bucket.done = r.n as number;
  }
  return [...buckets.values()];
}

function openByRepoCounts(db: Database.Database): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT repo_id, COUNT(*) AS n FROM tasks WHERE status IN ('queued','running','needs_review','merging') GROUP BY repo_id",
  ).all() as Row[]) {
    counts.set(r.repo_id as string, r.n as number);
  }
  return counts;
}

type OverviewSource = Pick<Store, "db" | "queuedForAnyone" | "listTaskSummaries" | "listGoalSummaries" |
  "listAgents" | "listRepos" | "repoTools" | "blockedTools">;

export function overview(store: OverviewSource, factory: Overview["factory"]): Overview {
  const counts = statusCounts(store.db);
  const t0 = Date.now();
  const spend = weeklySpend(store.db, t0);
  const activity = hourlyActivity(store.db, t0);
  const openByRepo = openByRepoCounts(store.db);
  return {
    factory,
    counts,
    queuedForAnyone: store.queuedForAnyone(),
    shippedThisWeek: shippedCount(store.db, t0 - WEEK_MS, t0 + 1),
    shippedLastWeek: shippedCount(store.db, t0 - 2 * WEEK_MS, t0 - WEEK_MS),
    spendThisWeekUsd: spend,
    activity,
    needsReview: store.listTaskSummaries({ status: ["needs_review"], limit: 20 }),
    goalsNeedingReview: store.listGoalSummaries(true),
    // A goal can enqueue up to 40 tasks at once. Its newer queued tasks must
    // never crowd running work or merges out of Home's list and crane site.
    inFlight: [
      ...store.listTaskSummaries({ status: ["running", "merging"], limit: -1 }),
      ...store.listTaskSummaries({ status: ["queued"], limit: 20 }),
    ],
    recent: store.listTaskSummaries({ status: FINISHED_STATUSES, limit: 8 }),
    agents: store.listAgents(),
    repos: store.listRepos().map((r) => ({ ...r, openTasks: openByRepo.get(r.id) ?? 0, tools: store.repoTools(r.id) })),
    // One refusal could be a fluke; the same one in a second task is a pattern worth a decision.
    blocked: store.blockedTools({ minTasks: 2 }).slice(0, 5),
  };
}
