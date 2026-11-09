import type Database from "better-sqlite3";
import { SHIPPED_STATUSES, UNSHIPPED_STATUSES, type Analytics, type TaskKind, type TaskStatus } from "@crane/contracts";
import type { Store } from "../store.js";
import { localDayStart, type Row } from "./rows.js";

type TaskSpend = Analytics["topTasks"][number];
const iso = (ms: number) => new Date(ms).toISOString();

function queryRuns(db: Database.Database, prevFrom: number): Row[] {
  return db.prepare(
    `SELECT r.task_id, r.driver, r.cost_usd, r.cost_status, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
                r.finished_at, t.title, t.status, t.kind, t.repo_id
         FROM runs r JOIN tasks t ON t.id = r.task_id
         WHERE r.outcome != 'running' AND r.finished_at >= ?`,
  ).all(iso(prevFrom)) as Row[];
}

function emptyTotals(days: number, nowMs: number) {
  const daily = new Map<number, { usd: number; runs: number }>();
  for (let i = days - 1; i >= 0; i--) daily.set(localDayStart(nowMs, i), { usd: 0, runs: 0 });
  return {
    daily,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    perTask: new Map<string, TaskSpend>(),
    perAgent: new Map<string, { usd: number; tasks: Set<string> }>(),
    spendUsd: 0, prevSpendUsd: 0, runs: 0, unknownCostRuns: 0,
  };
}

type Totals = ReturnType<typeof emptyTotals>;

function addTaskSpend(perTask: Totals["perTask"], r: Row) {
  const id = r.task_id as string;
  let task = perTask.get(id);
  if (!task) {
    task = {
      id,
      title: r.title as string,
      status: r.status as TaskStatus,
      kind: r.kind as TaskKind,
      repoId: (r.repo_id as string) ?? null,
      usd: 0,
      runs: 0,
    };
    perTask.set(id, task);
  }
  task.usd += r.cost_usd as number;
  task.runs++;
}

function addCurrentRun(totals: Totals, r: Row, at: number) {
  const usd = r.cost_usd as number;
  totals.spendUsd += usd;
  totals.runs++;
  if (r.cost_status === "unknown") totals.unknownCostRuns++;
  totals.tokens.input += r.input_tokens as number;
  totals.tokens.output += r.output_tokens as number;
  totals.tokens.cacheRead += r.cache_read_tokens as number;
  totals.tokens.cacheWrite += r.cache_write_tokens as number;
  const bucket = totals.daily.get(localDayStart(at));
  if (bucket) {
    bucket.usd += usd;
    bucket.runs++;
  }
  const driver = r.driver as string;
  const agent = totals.perAgent.get(driver) ?? { usd: 0, tasks: new Set<string>() };
  agent.usd += usd;
  agent.tasks.add(r.task_id as string);
  totals.perAgent.set(driver, agent);
  addTaskSpend(totals.perTask, r);
}

/** Pure aggregation of the queried ledger rows, preserving their insertion order. */
export function aggregateAnalytics(rows: readonly Row[], days: number, nowMs: number): Totals {
  const totals = emptyTotals(days, nowMs);
  const from = localDayStart(nowMs, days - 1);
  for (const row of rows) {
    const at = Date.parse(row.finished_at as string);
    if (at < from) totals.prevSpendUsd += row.cost_usd as number;
    else addCurrentRun(totals, row, at);
  }
  return totals;
}

function spendSlice(tasks: TaskSpend[]) {
  return { usd: tasks.reduce((sum, task) => sum + task.usd, 0), tasks: tasks.length };
}

function groupTasks<K extends string | null>(tasks: TaskSpend[], key: (task: TaskSpend) => K) {
  const groups = new Map<K, TaskSpend[]>();
  for (const task of tasks) {
    if (task.usd > 0) {
      const k = key(task);
      const group = groups.get(k);
      if (group) group.push(task);
      else groups.set(k, [task]);
    }
  }
  return [...groups.entries()].map(([k, list]) => ({ key: k, ...spendSlice(list) })).sort((a, b) => b.usd - a.usd);
}

function shapeAnalytics(totals: Totals, days: number, nowMs: number, repoNames: Map<string, string>): Analytics {
  const tasks = [...totals.perTask.values()];
  return {
    days,
    from: iso(localDayStart(nowMs, days - 1)),
    to: iso(nowMs),
    spendUsd: totals.spendUsd,
    unknownCostRuns: totals.unknownCostRuns,
    prevSpendUsd: totals.prevSpendUsd,
    runs: totals.runs,
    tasks: tasks.length,
    shipped: spendSlice(tasks.filter((t) => SHIPPED_STATUSES.includes(t.status))),
    unshipped: spendSlice(tasks.filter((t) => UNSHIPPED_STATUSES.includes(t.status))),
    tokens: totals.tokens,
    daily: [...totals.daily.entries()].map(([t, v]) => ({ day: iso(t), ...v })),
    byRepo: groupTasks(tasks, (t) => t.repoId).map(({ key, ...s }) => ({
      repoId: key,
      name: repoName(key, repoNames),
      ...s,
    })),
    byKind: groupTasks(tasks, (t) => t.kind).map(({ key, ...s }) => ({ kind: key, ...s })),
    byAgent: [...totals.perAgent].map(([driver, s]) => ({ driver, usd: s.usd, tasks: s.tasks.size }))
      .sort((a, b) => b.usd - a.usd || a.driver.localeCompare(b.driver)),
    topTasks: tasks.filter((t) => t.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 10),
  };
}

function repoName(id: string | null, names: Map<string, string>): string {
  if (!id) return "No repo";
  return names.get(id) ?? "Disconnected repo";
}

export function analytics(store: Pick<Store, "db" | "listRepos">, days: number, nowMs: number): Analytics {
  days = Math.max(1, Math.min(366, Math.floor(days) || 30));
  const rows = queryRuns(store.db, localDayStart(nowMs, 2 * days - 1));
  const totals = aggregateAnalytics(rows, days, nowMs);
  const repoNames = new Map(store.listRepos().map((r) => [r.id, r.name]));
  return shapeAnalytics(totals, days, nowMs, repoNames);
}
