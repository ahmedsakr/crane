import Database from "better-sqlite3";
import { basename } from "node:path";
import { dbPath } from "./paths.js";
import { shortId } from "./ids.js";
import { ALL_STATUSES, SHIPPED_STATUSES, UNSHIPPED_STATUSES } from "./types.js";
import { ruleLabel } from "./permissions.js";
import type {
  Agent,
  AgentRun,
  AgentState,
  Analytics,
  BlockedTool,
  RunKind,
  RunOutcome,
  RunUsage,
  TaskKind,
  EventType,
  RepoTools,
  Task,
  TaskEvent,
  TaskStatus,
  NewTask,
  Overview,
  Report,
  Repo,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  is_factory INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  repo_id TEXT REFERENCES repos(id),
  autonomy TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT,
  branch TEXT,
  worktree TEXT,
  session_id TEXT,
  driver TEXT,
  report TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  task_id TEXT,
  driver TEXT NOT NULL,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Created by migrateCostsToRuns, so the first open can backfill it from older tasks. */
const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  agent_id TEXT,
  driver TEXT NOT NULL,
  model TEXT,
  outcome TEXT NOT NULL DEFAULT 'running',
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, id);
CREATE INDEX IF NOT EXISTS runs_finished ON runs(finished_at);
`;

type Row = Record<string, unknown>;

const hasTable = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * Costs used to live only on the task row. Give every task that already cost
 * something one run carrying that cost, so analytics include past spend.
 */
function migrateCostsToRuns(db: Database.Database) {
  if (hasTable(db, "runs")) return;
  db.transaction(() => {
    if (hasTable(db, "runs")) return;
    db.exec(RUNS_SCHEMA);
    db.exec(`
      INSERT INTO runs(task_id, kind, agent_id, driver, outcome, cost_usd, started_at, finished_at)
      SELECT id, 'work', agent_id, 'unknown',
             CASE status WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE 'succeeded' END,
             cost_usd, COALESCE(started_at, created_at), COALESCE(finished_at, started_at, created_at)
      FROM tasks WHERE cost_usd > 0`);
  }).immediate();
}

/**
 * Crane used to call tasks "missions". Rename the old tables and columns in
 * place so existing history, ids, and branches carry over. Runs inside an
 * immediate transaction, so two processes opening the store at once can't
 * both try it.
 */
function migrateMissionsToTasks(db: Database.Database) {
  const has = (name: string) => hasTable(db, name);
  const hasColumn = (table: string, col: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === col);

  // Cheap check first, so normal opens never take the write lock.
  if (!has("missions") || has("tasks")) return;
  db.transaction(() => {
    // Check again under the lock: another process may have just migrated.
    if (!has("missions") || has("tasks")) return;
    db.exec("DROP INDEX IF EXISTS missions_status; DROP INDEX IF EXISTS events_mission;");
    db.exec("ALTER TABLE missions RENAME TO tasks");
    if (hasColumn("events", "mission_id")) db.exec("ALTER TABLE events RENAME COLUMN mission_id TO task_id");
    if (hasColumn("agents", "mission_id")) db.exec("ALTER TABLE agents RENAME COLUMN mission_id TO task_id");
    if (hasColumn("agents", "missions_completed")) {
      db.exec("ALTER TABLE agents RENAME COLUMN missions_completed TO tasks_completed");
    }
  }).immediate();
}

/** Columns added to `tasks` after its first release. */
const ADDED_TASK_COLUMNS: [name: string, type: string][] = [
  ["session_id", "TEXT"],
  ["driver", "TEXT"],
];

/** Add any missing columns to an older database. Safe if two processes open it at once. */
function addMissingColumns(db: Database.Database) {
  const missing = () => {
    const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as Row[]).map((c) => c.name));
    return ADDED_TASK_COLUMNS.filter(([name]) => !have.has(name));
  };
  if (!missing().length) return;
  db.transaction(() => {
    for (const [name, type] of missing()) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  }).immediate();
}

const now = () => new Date().toISOString();

function toRepo(r: Row): Repo {
  return {
    id: r.id as string,
    name: r.name as string,
    path: r.path as string,
    defaultBranch: r.default_branch as string,
    isFactory: !!r.is_factory,
    addedAt: r.added_at as string,
  };
}

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    kind: r.kind as Task["kind"],
    title: r.title as string,
    brief: r.brief as string,
    repoId: (r.repo_id as string) ?? null,
    autonomy: r.autonomy as Task["autonomy"],
    status: r.status as TaskStatus,
    agentId: (r.agent_id as string) ?? null,
    branch: (r.branch as string) ?? null,
    worktree: (r.worktree as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    driver: (r.driver as string) ?? null,
    report: r.report ? (JSON.parse(r.report as string) as Report) : null,
    costUsd: (r.cost_usd as number) ?? 0,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function toEvent(r: Row): TaskEvent {
  return {
    id: r.id as number,
    taskId: r.task_id as string,
    ts: r.ts as string,
    type: r.type as EventType,
    message: r.message as string,
    data: r.data ? JSON.parse(r.data as string) : null,
  };
}

function toRun(r: Row): AgentRun {
  return {
    id: r.id as number,
    taskId: r.task_id as string,
    kind: r.kind as RunKind,
    agentId: (r.agent_id as string) ?? null,
    driver: r.driver as string,
    model: (r.model as string) ?? null,
    outcome: r.outcome as RunOutcome,
    costUsd: r.cost_usd as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    turns: r.turns as number,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

/** Local midnight, `days` days before the one containing `ms`. */
function localDayStart(ms: number, daysBack = 0): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
}

function toAgent(r: Row): Agent {
  return {
    active: true,
    defaultDriver: null,
    id: r.id as string,
    name: r.name as string,
    state: r.state as AgentState,
    taskId: (r.task_id as string) ?? null,
    driver: r.driver as string,
    tasksCompleted: r.tasks_completed as number,
    lastActiveAt: (r.last_active_at as string) ?? null,
  };
}

/**
 * The single source of truth. Every process (the factory server, the CLI)
 * opens the same SQLite file in WAL mode, so the CLI works whether or not
 * the factory is running, and live views just tail the events table.
 */
export class Store {
  readonly db: Database.Database;

  constructor(file = dbPath()) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    migrateMissionsToTasks(this.db);
    this.db.exec(SCHEMA);
    addMissingColumns(this.db);
    migrateCostsToRuns(this.db);
  }

  close() {
    this.db.close();
  }

  // ── settings ──────────────────────────────────────────────
  getSetting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return (r?.value as string) ?? null;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  isPaused(): boolean {
    return this.getSetting("paused") === "1";
  }

  setPaused(paused: boolean) {
    this.setSetting("paused", paused ? "1" : "0");
  }

  // ── repos ─────────────────────────────────────────────────
  listRepos(): Repo[] {
    return (this.db.prepare("SELECT * FROM repos ORDER BY is_factory DESC, name").all() as Row[]).map(toRepo);
  }

  getRepo(idOrName: string): Repo | null {
    const r = this.db
      .prepare("SELECT * FROM repos WHERE id = ? OR name = ? OR path = ?")
      .get(idOrName, idOrName, idOrName) as Row | undefined;
    return r ? toRepo(r) : null;
  }

  addRepo(input: { path: string; name?: string; defaultBranch?: string; isFactory?: boolean }): Repo {
    const existing = this.getRepo(input.path);
    if (existing) return existing;
    const repo: Repo = {
      id: shortId("r", 4),
      name: input.name ?? basename(input.path),
      path: input.path,
      defaultBranch: input.defaultBranch ?? "main",
      isFactory: !!input.isFactory,
      addedAt: now(),
    };
    this.db
      .prepare("INSERT INTO repos(id, name, path, default_branch, is_factory, added_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(repo.id, repo.name, repo.path, repo.defaultBranch, repo.isFactory ? 1 : 0, repo.addedAt);
    return repo;
  }

  removeRepo(id: string) {
    this.db.prepare("DELETE FROM repos WHERE id = ? AND is_factory = 0").run(id);
  }

  /** The tool rules the operator has allowed, or chosen to keep blocked, for one repo. */
  repoTools(repoId: string): RepoTools {
    const raw = this.getSetting(`tools:${repoId}`);
    const parsed = raw ? (JSON.parse(raw) as Partial<RepoTools>) : {};
    return { allowed: parsed.allowed ?? [], keptBlocked: parsed.keptBlocked ?? [] };
  }

  repoChecks(repoId: string): string[] {
    const raw = this.getSetting(`checks:${repoId}`);
    return raw ? JSON.parse(raw) as string[] : this.getRepo(repoId)?.isFactory ? ["npm run typecheck", "npm test"] : [];
  }

  setRepoChecks(repoId: string, commands: string[]) {
    this.setSetting(`checks:${repoId}`, JSON.stringify(commands));
  }

  setRepoTools(repoId: string, tools: RepoTools) {
    this.setSetting(`tools:${repoId}`, JSON.stringify({ allowed: [...new Set(tools.allowed)], keptBlocked: [...new Set(tools.keptBlocked)] }));
  }

  /**
   * Rules agents were refused, added up per repo across tasks. Leaves out
   * rules the operator has already allowed or kept blocked for that repo.
   */
  blockedTools(opts: { repoId?: string; taskId?: string; minTasks?: number } = {}): BlockedTool[] {
    const where = ["e.type = 'blocked'"];
    const params: unknown[] = [];
    if (opts.repoId) {
      where.push("t.repo_id = ?");
      params.push(opts.repoId);
    }
    if (opts.taskId) {
      // Every task's count, but only for rules this task hit.
      where.push(
        `r.value IN (SELECT r2.value FROM events e2, json_each(e2.data, '$.rules') r2 WHERE e2.task_id = ? AND e2.type = 'blocked')`,
      );
      params.push(opts.taskId);
    }
    const rows = this.db
      .prepare(
        `SELECT t.repo_id AS repo_id, p.name AS repo_name, r.value AS rule,
                COUNT(DISTINCT e.task_id) AS tasks, COUNT(*) AS times, MAX(e.ts) AS last_at,
                (SELECT e3.task_id FROM events e3, json_each(e3.data, '$.rules') r3
                  JOIN tasks t3 ON t3.id = e3.task_id
                  WHERE e3.type = 'blocked' AND r3.value = r.value AND t3.repo_id = t.repo_id
                  ORDER BY e3.id DESC LIMIT 1) AS last_task_id
         FROM events e
         JOIN tasks t ON t.id = e.task_id
         JOIN repos p ON p.id = t.repo_id
         , json_each(e.data, '$.rules') r
         WHERE ${where.join(" AND ")}
         GROUP BY t.repo_id, r.value
         HAVING COUNT(DISTINCT e.task_id) >= ?
         ORDER BY tasks DESC, last_at DESC`,
      )
      .all(...params, opts.minTasks ?? 1) as Row[];
    const decided = new Map<string, Set<string>>();
    const isDecided = (repoId: string, rule: string) => {
      if (!decided.has(repoId)) {
        const t = this.repoTools(repoId);
        decided.set(repoId, new Set([...t.allowed, ...t.keptBlocked]));
      }
      return decided.get(repoId)!.has(rule);
    };
    return rows
      .filter((r) => !isDecided(r.repo_id as string, r.rule as string))
      .map((r) => ({
        repoId: r.repo_id as string,
        repoName: r.repo_name as string,
        rule: r.rule as string,
        label: ruleLabel(r.rule as string),
        tasks: r.tasks as number,
        times: r.times as number,
        lastAt: r.last_at as string,
        lastTaskId: r.last_task_id as string,
      }));
  }

  // ── tasks ─────────────────────────────────────────────────
  createTask(input: NewTask): Task {
    const id = shortId("t");
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks(id, kind, title, brief, repo_id, autonomy, driver, status, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(id, input.kind, input.title, input.brief, input.repoId, input.autonomy, input.driver ?? null, ts);
    this.addEvent(id, "status", "Queued", { status: "queued" });
    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    // Accept a bare id too. Tasks created before the rename kept their `m-` prefix.
    const r = this.db
      .prepare("SELECT * FROM tasks WHERE id IN (?, ?, ?) ORDER BY id = ? DESC LIMIT 1")
      .get(id, `t-${id}`, `m-${id}`, id) as Row | undefined;
    return r ? toTask(r) : null;
  }

  listTasks(opts: { status?: TaskStatus[]; repoId?: string; limit?: number } = {}): Task[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
      params.push(...opts.status);
    }
    if (opts.repoId) {
      where.push("repo_id = ?");
      params.push(opts.repoId);
    }
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY created_at DESC LIMIT ?`;
    params.push(opts.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as Row[]).map(toTask);
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id">>) {
    const cols: Record<string, string> = {
      status: "status",
      agentId: "agent_id",
      branch: "branch",
      worktree: "worktree",
      sessionId: "session_id",
      report: "report",
      costUsd: "cost_usd",
      startedAt: "started_at",
      finishedAt: "finished_at",
      title: "title",
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      params.push(k === "report" && v ? JSON.stringify(v) : v);
    }
    if (!sets.length) return;
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  setStatus(id: string, status: TaskStatus, message?: string, data?: Record<string, unknown>) {
    const patch: Partial<Task> = { status };
    if (status === "running") patch.startedAt = now();
    if (["needs_review", "done", "failed", "cancelled", "approved", "merged", "rejected"].includes(status)) {
      patch.finishedAt = now();
    }
    this.updateTask(id, patch);
    this.addEvent(id, "status", message ?? status, { ...data, status });
  }

  /** Atomically take the oldest queued task. Safe if two factories race. */
  claimNextTask(agentId: string): Task | null {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare("SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get() as Row | undefined;
      if (!r) return null;
      const changed = this.db
        .prepare("UPDATE tasks SET status = 'running', agent_id = ?, started_at = ? WHERE id = ? AND status = 'queued'")
        .run(agentId, now(), r.id).changes;
      return changed ? (r.id as string) : null;
    });
    const id = tx();
    if (!id) return null;
    this.addEvent(id, "status", "Picked up", { status: "running", agentId });
    return this.getTask(id);
  }

  /**
   * Atomically take the oldest task waiting to merge. Skips repos that already
   * have a merge in progress, so two merges never race for the same branch.
   */
  claimNextMerge(agentId: string, busyRepoIds: string[] = []): Task | null {
    const tx = this.db.transaction(() => {
      const skip = busyRepoIds.length ? `AND repo_id NOT IN (${busyRepoIds.map(() => "?").join(",")})` : "";
      const r = this.db
        .prepare(`SELECT id FROM tasks WHERE status = 'merging' AND agent_id IS NULL ${skip} ORDER BY finished_at ASC LIMIT 1`)
        .get(...busyRepoIds) as Row | undefined;
      if (!r) return null;
      const changed = this.db
        .prepare("UPDATE tasks SET agent_id = ? WHERE id = ? AND status = 'merging' AND agent_id IS NULL")
        .run(agentId, r.id).changes;
      return changed ? (r.id as string) : null;
    });
    const id = tx();
    if (!id) return null;
    this.addEvent(id, "note", "Picked up to merge", { agentId });
    return this.getTask(id);
  }

  // ── events ────────────────────────────────────────────────
  addEvent(taskId: string, type: EventType, message: string, data?: Record<string, unknown> | null): TaskEvent {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO events(task_id, ts, type, message, data) VALUES(?, ?, ?, ?, ?)")
      .run(taskId, ts, type, message, data ? JSON.stringify(data) : null);
    return { id: Number(info.lastInsertRowid), taskId, ts, type, message, data: data ?? null };
  }

  listEvents(taskId: string, afterId = 0): TaskEvent[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC").all(taskId, afterId) as Row[]
    ).map(toEvent);
  }

  /** Events across every task, for the live factory feed. */
  eventsSince(afterId: number, limit = 200): TaskEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(afterId, limit) as Row[]).map(
      toEvent,
    );
  }

  latestEventId(): number {
    const r = this.db.prepare("SELECT MAX(id) AS id FROM events").get() as Row;
    return (r.id as number) ?? 0;
  }

  // ── runs: what each agent run cost ────────────────────────
  startRun(input: { taskId: string; kind: RunKind; agentId: string | null; driver: string }): number {
    const info = this.db
      .prepare("INSERT INTO runs(task_id, kind, agent_id, driver, started_at) VALUES(?, ?, ?, ?, ?)")
      .run(input.taskId, input.kind, input.agentId, input.driver, now());
    return Number(info.lastInsertRowid);
  }

  /**
   * Close a run and add what it cost to its task, in one transaction so the
   * task's total always equals the sum of its runs. `usage` is null when the
   * run ended before its driver could say (e.g. it was killed).
   */
  finishRun(id: number, outcome: Exclude<RunOutcome, "running">, usage: RunUsage | null) {
    const u = usage ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, model: null };
    const cost = Number.isFinite(u.costUsd) && u.costUsd > 0 ? u.costUsd : 0;
    this.db.transaction(() => {
      const run = this.db
        .prepare(
          `UPDATE runs SET outcome = ?, finished_at = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?,
             cache_read_tokens = ?, cache_write_tokens = ?, turns = ?, model = COALESCE(?, model)
           WHERE id = ? AND outcome = 'running' RETURNING task_id`,
        )
        .get(outcome, now(), cost, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.turns, u.model, id) as
        | Row
        | undefined;
      // Already closed (say, by a restarted factory): don't count its cost twice.
      if (run && cost) this.db.prepare("UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?").run(cost, run.task_id);
    })();
  }

  /** Runs a dead factory left open. Their cost is unknown, so they close at zero. */
  closeStaleRuns(): number {
    return this.db.prepare("UPDATE runs SET outcome = 'cancelled', finished_at = ? WHERE outcome = 'running'").run(now()).changes;
  }

  listRuns(taskId: string): AgentRun[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id ASC").all(taskId) as Row[]).map(toRun);
  }

  /** The driver of the task's latest work run, which owns its session. Null before its first run. */
  lastWorkDriver(taskId: string): string | null {
    const r = this.db
      .prepare("SELECT driver FROM runs WHERE task_id = ? AND kind = 'work' ORDER BY id DESC LIMIT 1")
      .get(taskId) as Row | undefined;
    return (r?.driver as string) ?? null;
  }

  /** Spend over the last `days` local days, today included, with the same span before it for comparison. */
  analytics(days = 30, nowMs = Date.now()): Analytics {
    days = Math.max(1, Math.min(366, Math.floor(days) || 30));
    const iso = (ms: number) => new Date(ms).toISOString();
    const from = localDayStart(nowMs, days - 1);
    const prevFrom = localDayStart(nowMs, 2 * days - 1);
    const rows = this.db
      .prepare(
        `SELECT r.task_id, r.driver, r.cost_usd, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
                r.finished_at, t.title, t.status, t.kind, t.repo_id
         FROM runs r JOIN tasks t ON t.id = r.task_id
         WHERE r.outcome != 'running' AND r.finished_at >= ?`,
      )
      .all(iso(prevFrom)) as Row[];

    const daily = new Map<number, { usd: number; runs: number }>();
    for (let i = days - 1; i >= 0; i--) daily.set(localDayStart(nowMs, i), { usd: 0, runs: 0 });
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    type TaskSpend = Analytics["topTasks"][number];
    const perTask = new Map<string, TaskSpend>();
    const perAgent = new Map<string, { usd: number; tasks: Set<string> }>();
    let spendUsd = 0;
    let prevSpendUsd = 0;
    let runs = 0;

    for (const r of rows) {
      const at = Date.parse(r.finished_at as string);
      const usd = r.cost_usd as number;
      if (at < from) {
        prevSpendUsd += usd;
        continue;
      }
      spendUsd += usd;
      runs++;
      tokens.input += r.input_tokens as number;
      tokens.output += r.output_tokens as number;
      tokens.cacheRead += r.cache_read_tokens as number;
      tokens.cacheWrite += r.cache_write_tokens as number;
      const b = daily.get(localDayStart(at));
      if (b) {
        b.usd += usd;
        b.runs++;
      }
      const id = r.task_id as string;
      const driver = r.driver as string;
      const agent = perAgent.get(driver) ?? { usd: 0, tasks: new Set<string>() };
      agent.usd += usd;
      agent.tasks.add(id);
      perAgent.set(driver, agent);
      const t =
        perTask.get(id) ??
        perTask
          .set(id, {
            id,
            title: r.title as string,
            status: r.status as TaskStatus,
            kind: r.kind as TaskKind,
            repoId: (r.repo_id as string) ?? null,
            usd: 0,
            runs: 0,
          })
          .get(id)!;
      t.usd += usd;
      t.runs++;
    }

    const tasks = [...perTask.values()];
    const slice = (list: TaskSpend[]) => ({ usd: list.reduce((s, t) => s + t.usd, 0), tasks: list.length });
    const groupBy = <K extends string | null>(key: (t: TaskSpend) => K) => {
      const groups = new Map<K, TaskSpend[]>();
      for (const t of tasks) if (t.usd > 0) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
      return [...groups.entries()].map(([k, list]) => ({ key: k, ...slice(list) })).sort((a, b) => b.usd - a.usd);
    };
    const repoNames = new Map(this.listRepos().map((r) => [r.id, r.name]));

    return {
      days,
      from: iso(from),
      to: iso(nowMs),
      spendUsd,
      prevSpendUsd,
      runs,
      tasks: tasks.length,
      shipped: slice(tasks.filter((t) => SHIPPED_STATUSES.includes(t.status))),
      unshipped: slice(tasks.filter((t) => UNSHIPPED_STATUSES.includes(t.status))),
      tokens,
      daily: [...daily.entries()].map(([t, v]) => ({ day: iso(t), ...v })),
      byRepo: groupBy((t) => t.repoId).map(({ key, ...s }) => ({
        repoId: key,
        name: key ? (repoNames.get(key) ?? "Disconnected repo") : "No repo",
        ...s,
      })),
      byKind: groupBy((t) => t.kind).map(({ key, ...s }) => ({ kind: key, ...s })),
      byAgent: [...perAgent].map(([driver, s]) => ({ driver, usd: s.usd, tasks: s.tasks.size }))
        .sort((a, b) => b.usd - a.usd || a.driver.localeCompare(b.driver)),
      topTasks: tasks
        .filter((t) => t.usd > 0)
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 10),
    };
  }

  // ── agents ────────────────────────────────────────────────
  listAgents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY name").all() as Row[]).map((r) => ({
      ...toAgent(r),
      active: this.getSetting(`crew_active_${r.id}`) !== "false",
      defaultDriver: this.getSetting(`crew_driver_${r.id}`) || null,
    }));
  }

  upsertAgent(a: Pick<Agent, "id" | "name" | "driver">) {
    this.db
      .prepare(
        `INSERT INTO agents(id, name, driver) VALUES(?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, driver = excluded.driver`,
      )
      .run(a.id, a.name, a.driver);
  }

  setAgentState(id: string, state: AgentState, taskId: string | null) {
    this.db
      .prepare("UPDATE agents SET state = ?, task_id = ?, last_active_at = ? WHERE id = ?")
      .run(state, taskId, now(), id);
  }

  /** Which agent a crew member is running on right now. It changes with each task's choice. */
  setAgentDriver(id: string, driver: string) {
    this.db.prepare("UPDATE agents SET driver = ? WHERE id = ?").run(driver, id);
  }

  bumpAgentCompleted(id: string) {
    this.db.prepare("UPDATE agents SET tasks_completed = tasks_completed + 1 WHERE id = ?").run(id);
  }

  /** Remove agents beyond the configured crew size. */
  pruneAgents(keepIds: string[]) {
    if (!keepIds.length) return;
    this.db
      .prepare(`DELETE FROM agents WHERE id NOT IN (${keepIds.map(() => "?").join(",")}) AND state != 'working'`)
      .run(...keepIds);
  }

  // ── overview ──────────────────────────────────────────────
  overview(factory: Overview["factory"]): Overview {
    const counts = Object.fromEntries(
      ALL_STATUSES.map((s) => [s, 0]),
    ) as Overview["counts"];
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as Row[]) {
      counts[r.status as TaskStatus] = r.n as number;
    }

    const weekMs = 7 * 24 * 3600 * 1000;
    const t0 = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const shippedIn = SHIPPED_STATUSES.map((s) => `'${s}'`).join(",");
    const shipped = (from: number, to: number) =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM tasks WHERE status IN (${shippedIn}) AND finished_at >= ? AND finished_at < ?`,
          )
          .get(iso(from), iso(to)) as Row
      ).n as number;

    // Counted when the money was spent, not when the task was created.
    const spend = (
      this.db
        .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE outcome != 'running' AND finished_at >= ?")
        .get(iso(t0 - weekMs)) as Row
    ).s as number;

    // Hourly activity buckets for the last 7 days.
    const hour = 3600 * 1000;
    const start = Math.floor((t0 - weekMs) / hour) * hour;
    const buckets = new Map<number, { done: number; events: number }>();
    for (let t = start; t <= t0; t += hour) buckets.set(t, { done: 0, events: 0 });
    for (const r of this.db
      .prepare("SELECT ts FROM events WHERE ts >= ? AND type IN ('note','tool','finding')")
      .all(iso(start)) as Row[]) {
      const b = buckets.get(Math.floor(Date.parse(r.ts as string) / hour) * hour);
      if (b) b.events++;
    }
    for (const r of this.db
      .prepare(`SELECT finished_at FROM tasks WHERE status IN (${shippedIn}) AND finished_at >= ?`)
      .all(iso(start)) as Row[]) {
      const b = buckets.get(Math.floor(Date.parse(r.finished_at as string) / hour) * hour);
      if (b) b.done++;
    }

    const openByRepo = new Map<string, number>();
    for (const r of this.db
      .prepare(
        "SELECT repo_id, COUNT(*) AS n FROM tasks WHERE status IN ('queued','running','needs_review','merging') GROUP BY repo_id",
      )
      .all() as Row[]) {
      openByRepo.set(r.repo_id as string, r.n as number);
    }

    return {
      factory,
      counts,
      shippedThisWeek: shipped(t0 - weekMs, t0 + 1),
      shippedLastWeek: shipped(t0 - 2 * weekMs, t0 - weekMs),
      spendThisWeekUsd: spend,
      activity: [...buckets.entries()].map(([t, v]) => ({ t: iso(t), ...v })),
      needsReview: this.listTasks({ status: ["needs_review"], limit: 20 }),
      inFlight: this.listTasks({ status: ["merging", "running", "queued"], limit: 20 }),
      recent: this.listTasks({ status: ["merged", "done", "approved", "rejected", "failed", "cancelled"], limit: 8 }),
      agents: this.listAgents(),
      repos: this.listRepos().map((r) => ({ ...r, openTasks: openByRepo.get(r.id) ?? 0, tools: this.repoTools(r.id) })),
      // One refusal could be a fluke; the same one in a second task is a pattern worth a decision.
      blocked: this.blockedTools({ minTasks: 2 }).slice(0, 5),
    };
  }
}
