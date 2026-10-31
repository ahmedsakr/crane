import Database from "better-sqlite3";
import { basename } from "node:path";
import { dbPath } from "./paths.js";
import { shortId } from "./ids.js";
import type {
  Agent,
  AgentState,
  EventType,
  Mission,
  MissionEvent,
  MissionStatus,
  NewMission,
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
CREATE TABLE IF NOT EXISTS missions (
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
  report TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS missions_status ON missions(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_mission ON events(mission_id, id);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  mission_id TEXT,
  driver TEXT NOT NULL,
  missions_completed INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

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

function toMission(r: Row): Mission {
  return {
    id: r.id as string,
    kind: r.kind as Mission["kind"],
    title: r.title as string,
    brief: r.brief as string,
    repoId: (r.repo_id as string) ?? null,
    autonomy: r.autonomy as Mission["autonomy"],
    status: r.status as MissionStatus,
    agentId: (r.agent_id as string) ?? null,
    branch: (r.branch as string) ?? null,
    worktree: (r.worktree as string) ?? null,
    report: r.report ? (JSON.parse(r.report as string) as Report) : null,
    costUsd: (r.cost_usd as number) ?? 0,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function toEvent(r: Row): MissionEvent {
  return {
    id: r.id as number,
    missionId: r.mission_id as string,
    ts: r.ts as string,
    type: r.type as EventType,
    message: r.message as string,
    data: r.data ? JSON.parse(r.data as string) : null,
  };
}

function toAgent(r: Row): Agent {
  return {
    id: r.id as string,
    name: r.name as string,
    state: r.state as AgentState,
    missionId: (r.mission_id as string) ?? null,
    driver: r.driver as string,
    missionsCompleted: r.missions_completed as number,
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
    this.db.exec(SCHEMA);
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

  // ── missions ──────────────────────────────────────────────
  createMission(input: NewMission): Mission {
    const id = shortId("m");
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO missions(id, kind, title, brief, repo_id, autonomy, status, created_at)
         VALUES(?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(id, input.kind, input.title, input.brief, input.repoId, input.autonomy, ts);
    this.addEvent(id, "status", "Queued", { status: "queued" });
    return this.getMission(id)!;
  }

  getMission(id: string): Mission | null {
    const r = this.db.prepare("SELECT * FROM missions WHERE id = ? OR id = ?").get(id, `m-${id}`) as Row | undefined;
    return r ? toMission(r) : null;
  }

  listMissions(opts: { status?: MissionStatus[]; repoId?: string; limit?: number } = {}): Mission[] {
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
    const sql = `SELECT * FROM missions ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY created_at DESC LIMIT ?`;
    params.push(opts.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as Row[]).map(toMission);
  }

  updateMission(id: string, patch: Partial<Omit<Mission, "id">>) {
    const cols: Record<string, string> = {
      status: "status",
      agentId: "agent_id",
      branch: "branch",
      worktree: "worktree",
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
    this.db.prepare(`UPDATE missions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  setStatus(id: string, status: MissionStatus, message?: string) {
    const patch: Partial<Mission> = { status };
    if (status === "running") patch.startedAt = now();
    if (["needs_review", "done", "failed", "cancelled", "approved", "rejected"].includes(status)) {
      patch.finishedAt = now();
    }
    this.updateMission(id, patch);
    this.addEvent(id, "status", message ?? status, { status });
  }

  /** Atomically take the oldest queued mission. Safe if two factories race. */
  claimNextMission(agentId: string): Mission | null {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare("SELECT id FROM missions WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get() as Row | undefined;
      if (!r) return null;
      const changed = this.db
        .prepare("UPDATE missions SET status = 'running', agent_id = ?, started_at = ? WHERE id = ? AND status = 'queued'")
        .run(agentId, now(), r.id).changes;
      return changed ? (r.id as string) : null;
    });
    const id = tx();
    if (!id) return null;
    this.addEvent(id, "status", "Picked up", { status: "running", agentId });
    return this.getMission(id);
  }

  // ── events ────────────────────────────────────────────────
  addEvent(missionId: string, type: EventType, message: string, data?: Record<string, unknown> | null): MissionEvent {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO events(mission_id, ts, type, message, data) VALUES(?, ?, ?, ?, ?)")
      .run(missionId, ts, type, message, data ? JSON.stringify(data) : null);
    return { id: Number(info.lastInsertRowid), missionId, ts, type, message, data: data ?? null };
  }

  listEvents(missionId: string, afterId = 0): MissionEvent[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE mission_id = ? AND id > ? ORDER BY id ASC").all(missionId, afterId) as Row[]
    ).map(toEvent);
  }

  /** Events across every mission, for the live factory feed. */
  eventsSince(afterId: number, limit = 200): MissionEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(afterId, limit) as Row[]).map(
      toEvent,
    );
  }

  latestEventId(): number {
    const r = this.db.prepare("SELECT MAX(id) AS id FROM events").get() as Row;
    return (r.id as number) ?? 0;
  }

  // ── agents ────────────────────────────────────────────────
  listAgents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY name").all() as Row[]).map(toAgent);
  }

  upsertAgent(a: Pick<Agent, "id" | "name" | "driver">) {
    this.db
      .prepare(
        `INSERT INTO agents(id, name, driver) VALUES(?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, driver = excluded.driver`,
      )
      .run(a.id, a.name, a.driver);
  }

  setAgentState(id: string, state: AgentState, missionId: string | null) {
    this.db
      .prepare("UPDATE agents SET state = ?, mission_id = ?, last_active_at = ? WHERE id = ?")
      .run(state, missionId, now(), id);
  }

  bumpAgentCompleted(id: string) {
    this.db.prepare("UPDATE agents SET missions_completed = missions_completed + 1 WHERE id = ?").run(id);
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
      ["queued", "running", "needs_review", "approved", "rejected", "done", "failed", "cancelled"].map((s) => [s, 0]),
    ) as Overview["counts"];
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS n FROM missions GROUP BY status").all() as Row[]) {
      counts[r.status as MissionStatus] = r.n as number;
    }

    const weekMs = 7 * 24 * 3600 * 1000;
    const t0 = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const shipped = (from: number, to: number) =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM missions WHERE status IN ('done','approved') AND finished_at >= ? AND finished_at < ?`,
          )
          .get(iso(from), iso(to)) as Row
      ).n as number;

    const spend = (
      this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM missions WHERE created_at >= ?").get(iso(t0 - weekMs)) as Row
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
      .prepare("SELECT finished_at FROM missions WHERE status IN ('done','approved') AND finished_at >= ?")
      .all(iso(start)) as Row[]) {
      const b = buckets.get(Math.floor(Date.parse(r.finished_at as string) / hour) * hour);
      if (b) b.done++;
    }

    const openByRepo = new Map<string, number>();
    for (const r of this.db
      .prepare("SELECT repo_id, COUNT(*) AS n FROM missions WHERE status IN ('queued','running','needs_review') GROUP BY repo_id")
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
      needsReview: this.listMissions({ status: ["needs_review"], limit: 20 }),
      inFlight: this.listMissions({ status: ["running", "queued"], limit: 20 }),
      recent: this.listMissions({ status: ["done", "approved", "rejected", "failed", "cancelled"], limit: 8 }),
      agents: this.listAgents(),
      repos: this.listRepos().map((r) => ({ ...r, openMissions: openByRepo.get(r.id) ?? 0 })),
    };
  }
}
