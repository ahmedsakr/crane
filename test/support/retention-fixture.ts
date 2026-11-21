import type { TestContext } from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStatus } from "@crane/contracts";
import { Store } from "@crane/storage";

export const clock = Date.parse("2026-10-20T12:00:00.000Z");
export const day = 86_400_000;
export const old = new Date(clock - 40 * day).toISOString();
export const cutoff = new Date(clock - 30 * day).toISOString();

export function setupRetention(t: TestContext, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "crane-retention-"));
  const previousHome = process.env.CRANE_HOME;
  process.env.CRANE_HOME = root;
  const file = join(root, "crane.db");
  if (legacy) {
    const db = new Database(file);
    db.exec("CREATE TABLE legacy_fixture (value TEXT)");
    db.close();
  }
  const store = new Store(file);
  t.after(() => {
    store.close();
    if (previousHome === undefined) delete process.env.CRANE_HOME;
    else process.env.CRANE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  const task = (status: TaskStatus = "done", finishedAt: string | null = old) => {
    const task = store.createTask({ kind: "maintenance", title: "History", brief: "", repoId: null, autonomy: "observe" });
    store.updateTask(task.id, { status, finishedAt });
    return task.id;
  };
  const ageEvents = () => store.db.prepare("UPDATE events SET ts = ?").run(old);
  return { root, store, task, ageEvents };
}
