import type Database from "better-sqlite3";
import type { Report } from "@crane/contracts";
import { RUNS_SCHEMA } from "./schema.js";
import type { Row } from "./rows.js";

export const hasTable = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * Costs used to live only on the task row. Give every task that already cost
 * something one run carrying that cost, so analytics include past spend.
 */
export function migrateCostsToRuns(db: Database.Database) {
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

export function migrateCostStatus(db: Database.Database) {
  const has = () => (db.prepare("PRAGMA table_info(runs)").all() as Row[]).some((c) => c.name === "cost_status");
  if (has()) return;
  db.transaction(() => {
    if (has()) return;
    db.exec("ALTER TABLE runs ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'unknown'");
    // Historical Codex zeros were placeholders, never evidence of free usage.
    db.exec("UPDATE runs SET cost_status = 'reported' WHERE cost_usd > 0 OR (driver != 'codex' AND turns > 0)");
  }).immediate();
}

/**
 * Crane used to call tasks "missions". Rename the old tables and columns in
 * place so existing history, ids, and branches carry over. Runs inside an
 * immediate transaction, so two processes opening the store at once can't
 * both try it.
 */
export function migrateMissionsToTasks(db: Database.Database) {
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
  ["assignee", "TEXT"],
  ["model", "TEXT"],
  ["effort", "TEXT"],
  ["driver_settings", "TEXT"],
  ["pre_approved_at", "TEXT"],
  ["prerequisites", "TEXT"],
  ["prerequisites_waived_at", "TEXT"],
  ["acceptance", "TEXT"],
  ["acceptance_checks", "TEXT"],
  ["lookouts", "TEXT"],
  ["scheduled_at", "TEXT"],
  ["schedule_id", "TEXT"],
  ["visual_review", "TEXT"],
  ["review_checkpoint", "TEXT"],
  // Older tasks share 0 and keep their original FIFO order until moved.
  ["queue_position", "INTEGER NOT NULL DEFAULT 0"],
];

/** Add any missing columns to an older database. Safe if two processes open it at once. */
export function addMissingColumns(db: Database.Database) {
  const missing = () => {
    const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as Row[]).map((c) => c.name));
    return ADDED_TASK_COLUMNS.filter(([name]) => !have.has(name));
  };
  if (!missing().length) return;
  db.transaction(() => {
    for (const [name, type] of missing()) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  }).immediate();
}

/**
 * Follow-ups used to be linked to the finding they came from only by the
 * "Started follow-up" event on the source task. Add the link columns and fill
 * them from those events, matching each follow-up to the finding with its
 * title (a follow-up takes its finding's title), so findings show the state of
 * work already started from them.
 */
export function migrateFollowUpLinks(db: Database.Database) {
  const has = () => (db.prepare("PRAGMA table_info(tasks)").all() as Row[]).some((c) => c.name === "follow_up_of");
  if (!has()) {
    db.transaction(() => {
      if (has()) return;
      db.exec("ALTER TABLE tasks ADD COLUMN follow_up_of TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN follow_up_finding INTEGER");
      const started = db.prepare(
        `SELECT e.task_id AS source, child.id AS id, child.title AS title, parent.report AS report
         FROM events e
         JOIN tasks child ON child.id = CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.taskId') END
         JOIN tasks parent ON parent.id = e.task_id
         WHERE e.type = 'operator' AND e.message LIKE 'Started follow-up %'
         ORDER BY e.id`,
      ).all() as Row[];
      const link = db.prepare("UPDATE tasks SET follow_up_of = ?, follow_up_finding = ? WHERE id = ? AND follow_up_of IS NULL");
      for (const r of started) {
        const findings = r.report ? ((JSON.parse(r.report as string) as Report).findings ?? []) : [];
        const finding = findings.findIndex((f) => f.title === r.title);
        link.run(r.source, finding < 0 ? null : finding, r.id);
      }
    }).immediate();
  }
  db.exec("CREATE INDEX IF NOT EXISTS tasks_follow_up ON tasks(follow_up_of)");
}

/**
 * Post-mortems used to be linked to their merged task only by the note written
 * when they were queued. Add the column and fill it from those notes, so reviews
 * already waiting go to the crew the operator names.
 */
export function migratePostmortemLinks(db: Database.Database) {
  const has = () => (db.prepare("PRAGMA table_info(tasks)").all() as Row[]).some((c) => c.name === "postmortem_of");
  if (has()) return;
  db.transaction(() => {
    if (has()) return;
    db.exec("ALTER TABLE tasks ADD COLUMN postmortem_of TEXT");
    db.exec(`UPDATE tasks SET postmortem_of = (
      SELECT CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.sourceTaskId') END
      FROM events e
      WHERE e.task_id = tasks.id AND e.type = 'note' AND e.message LIKE 'Reviewing merged task %'
      ORDER BY e.id LIMIT 1
    )`);
  }).immediate();
}

/**
 * Post-mortems used to store a rendered copy of their merged task's history as
 * their brief. Keep its first line, which is what they store now. Queued and
 * running ones wait for a later open, so a factory still on the older build
 * doesn't start one without its history; the prompt doesn't use their copy anyway.
 */
export function migratePostmortemBriefs(db: Database.Database) {
  const legacy = `postmortem_of IS NOT NULL AND status NOT IN ('queued', 'running')
    AND brief LIKE 'Evaluate the execution of successfully merged task %' AND instr(brief, char(10)) > 0`;
  // Runs on every open, so don't take the write lock unless there's something to do.
  if (!db.prepare(`SELECT 1 FROM tasks WHERE ${legacy} LIMIT 1`).get()) return;
  db.exec(`UPDATE tasks SET brief = substr(brief, 1, instr(brief, char(10)) - 1) WHERE ${legacy}`);
}
