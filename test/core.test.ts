import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftTask } from "../src/factory/instruct.js";
import { parseReport } from "@crane/agent-protocol";
import { Store } from "@crane/storage";
import type { Repo } from "@crane/contracts";
import { temporaryRoot } from "./support/fixtures.ts";

test("store: extraction preserves schema and persisted rows across ordinary opens", (t) => {
  const file = join(temporaryRoot(t, "crane-storage-reopen-"), "crane.db");
  const store = new Store(file);
  const repo = store.addRepo({ path: "/code/persisted" });
  const task = store.createTask({ kind: "maintenance", title: "Persisted", brief: "Keep", repoId: repo.id, autonomy: "observe" });
  store.access.createOperator({ username: "robin", name: "Robin", role: "admin", passwordHash: "digest", at: "2026-01-01T00:00:00Z" });
  store.claimNextTask("a-1");
  store.addEvent(task.id, "note", "Persist this event");
  store.close();
  const snapshot = () => {
    const db = new Database(file, { readonly: true });
    try {
      const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      const rows = tables.map(({ name }) => db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all());
      return { schema, rows, version: db.pragma("user_version"), vacuum: db.pragma("auto_vacuum") };
    } finally {
      db.close();
    }
  };
  const before = snapshot();
  const reopened = new Store(file);
  assert.equal(reopened.getTask(task.id)?.title, "Persisted");
  assert.equal(reopened.access.countOperators(), 1);
  reopened.close();
  assert.deepEqual(snapshot(), before);
});

const repo = (name: string, isFactory = false): Repo => ({
  id: `r-${name}`,
  name,
  path: `/code/${name}`,
  defaultBranch: "main",
  isFactory,
  addedAt: new Date().toISOString(),
});
const repos = [repo("crane", true), repo("payments-api"), repo("storefront")];

test("draft: research wording stays read-only", () => {
  const d = draftTask("Investigate why the checkout tests are flaky in payments-api", repos);
  assert.equal(d.kind, "maintenance");
  assert.equal(d.repoId, "r-payments-api");
  assert.equal(d.autonomy, "observe");
});

test("draft: a requested change waits for review", () => {
  const d = draftTask("Add saved carts to storefront", repos);
  assert.equal(d.kind, "repo_feature");
  assert.equal(d.repoId, "r-storefront");
  assert.equal(d.autonomy, "propose");
});

test("draft: mentioning Crane targets the factory", () => {
  const d = draftTask("Research what crane should build next", repos);
  assert.equal(d.kind, "factory_feature");
  assert.equal(d.repoId, "r-crane");
});

test("draft: Crane's own vocabulary targets Crane even with one other repo connected", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  for (const text of [
    `I'd like to change the "missions" concept to be more "tasks" oriented`,
    `I'd like to rework the "Missions" concept to be more "Tasks" narrative`,
  ]) {
    const d = draftTask(text, two);
    assert.equal(d.repoId, "r-crane", text);
    assert.equal(d.kind, "factory_feature");
  }
});

test("draft: with no signal, Crane is still a candidate, so it asks", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  assert.equal(draftTask("Clean up the logging", two).repoId, null);
});

test("draft: falls back to the repo used last", () => {
  const two = [repo("crane", true), repo("wedding-guest-service")];
  assert.equal(draftTask("Clean up the logging", two, { lastRepoId: "r-crane" }).repoId, "r-crane");
  // An explicit mention still wins over memory.
  assert.equal(
    draftTask("Clean up the logging in wedding-guest-service", two, { lastRepoId: "r-crane" }).repoId,
    "r-wedding-guest-service",
  );
});

test("draft: ambiguous repo is left for the operator", () => {
  const d = draftTask("Fix the flaky tests", repos);
  assert.equal(d.repoId, null);
});

test("report: parses the fenced block", () => {
  const text = 'Done.\n\n```crane-report\n{"summary":"All good.","findings":[{"title":"A","detail":"B","impact":"high","effort":"tiny"}],"changedFiles":["x.ts"]}\n```';
  const r = parseReport(text);
  assert.equal(r.summary, "All good.");
  assert.equal(r.findings[0]!.impact, "high");
  assert.equal(r.findings[0]!.effort, "medium"); // unknown values fall back
  assert.deepEqual(r.changedFiles, ["x.ts"]);
});

test("report: falls back to the first paragraph", () => {
  const r = parseReport("The cache key ignores the locale.\n\nMore detail here.");
  assert.equal(r.summary, "The cache key ignores the locale.");
  assert.equal(r.findings.length, 0);
});

test("store: tasks are claimed once, oldest first", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "crane-")), "t.db"));
  const r = store.addRepo({ path: "/code/x" });
  const a = store.createTask({ kind: "maintenance", title: "first", brief: "", repoId: r.id, autonomy: "observe" });
  store.createTask({ kind: "maintenance", title: "second", brief: "", repoId: r.id, autonomy: "observe" });
  assert.equal(store.claimNextTask("a-1")?.id, a.id);
  assert.equal(store.claimNextTask("a-2")?.title, "second");
  assert.equal(store.claimNextTask("a-3"), null);
  assert.equal(store.getTask(a.id)?.status, "running");
  store.close();
});

test("worktree: picks the install command from the lockfile", async () => {
  const { installCommandFor } = await import("../packages/worktree-deps/src/deps.js");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "crane-install-"));
  assert.equal(installCommandFor(dir), null, "no package.json, nothing to install");
  writeFileSync(join(dir, "package.json"), "{}");
  assert.equal(installCommandFor(dir), null, "no lockfile, nothing to install");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  assert.equal(installCommandFor(dir)?.cmd, "npm");
  assert.deepEqual(installCommandFor(dir)?.args.slice(0, 1), ["ci"]);
  mkdirSync(join(dir, "node_modules"));
  assert.equal(installCommandFor(dir)?.cmd, "npm", "an existing directory alone does not prove dependencies are current");
});

test("worktree: copies dependencies from the checkout only when they match the lockfile", async () => {
  const { copyDependencies } = await import("../packages/worktree-deps/src/deps.js");
  const { installDependencies } = await import("@crane/worktree-deps");
  const { writeFileSync, mkdirSync, symlinkSync, readlinkSync, readFileSync, existsSync } = await import("node:fs");
  const lock = (extra = {}) =>
    JSON.stringify({
      packages: {
        "": { name: "x" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/fsevents": { version: "2.0.0", optional: true },
        "web/node_modules/b": { version: "2.0.0" },
        ...extra,
      },
    });
  const hidden = (version = "1.0.0") =>
    JSON.stringify({ packages: { "node_modules/a": { version }, "web/node_modules/b": { version: "2.0.0" } } });

  const setup = () => {
    const from = mkdtempSync(join(tmpdir(), "crane-from-"));
    const to = mkdtempSync(join(tmpdir(), "crane-to-"));
    for (const root of [from, to]) {
      mkdirSync(join(root, "web"));
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "web", "package.json"), "{}");
      writeFileSync(join(root, "package-lock.json"), lock());
    }
    mkdirSync(join(from, "node_modules", "a"), { recursive: true });
    mkdirSync(join(from, "web", "node_modules", "b"), { recursive: true });
    writeFileSync(join(from, "node_modules", "a", "index.js"), "module.exports = 1");
    writeFileSync(join(from, "node_modules", ".package-lock.json"), hidden());
    // A relative link stays as is; an absolute one into the checkout gets pointed at the worktree.
    symlinkSync("../../web", join(from, "node_modules", "web"));
    symlinkSync(join(from, "web"), join(from, "node_modules", "web-abs"));
    return { from, to };
  };

  // Workspace packages are found from the package.json files git tracks.
  const { execFileSync } = await import("node:child_process");
  // No stdin pipe: closing one fails with EPERM in Codex's sandbox.
  const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const gitInit = (dir: string) => {
    git(dir, "init", "-q");
    git(dir, "add", "package.json", "web/package.json");
  };

  {
    const { from, to } = setup();
    gitInit(from);
    gitInit(to);
    assert.deepEqual(await copyDependencies(from, to), { copied: ["node_modules", "web/node_modules"] });
    assert.equal(readFileSync(join(to, "node_modules", "a", "index.js"), "utf8"), "module.exports = 1");
    assert.ok(existsSync(join(to, "web", "node_modules", "b")));
    assert.equal(readlinkSync(join(to, "node_modules", "web")), "../../web");
    assert.equal(readlinkSync(join(to, "node_modules", "web-abs")), "../web");
    assert.deepEqual(await copyDependencies(from, to), { skipped: "the worktree already has node_modules" }, "already in place");
    assert.equal(await installDependencies(to, { from }), null, "nothing left to do");
  }
  {
    const { from, to } = setup();
    writeFileSync(join(to, "package-lock.json"), lock({ "node_modules/c": { version: "3.0.0" } }));
    assert.deepEqual(
      await copyDependencies(from, to),
      { skipped: "its package-lock.json differs from the worktree's" },
      "the worktree pins something else",
    );
  }
  {
    const { from, to } = setup();
    writeFileSync(join(from, "node_modules", ".package-lock.json"), hidden("0.9.0"));
    assert.deepEqual(
      await copyDependencies(from, to),
      { skipped: "what it has installed doesn't match its package-lock.json (run npm install there)" },
      "the checkout's install is stale",
    );
  }
  {
    const { from, to } = setup();
    assert.deepEqual(await copyDependencies(from, to), { copied: ["node_modules"] }, "outside git, just the root");
  }
});

test("worktree: npm's record of what's installed must agree with the lockfile", async () => {
  const { npmInstallMatches } = await import("../packages/worktree-deps/src/deps.js");
  const lock = { packages: { "": {}, "node_modules/a": { version: "1" }, "node_modules/b": { version: "1", optional: true } } };
  assert.ok(npmInstallMatches(lock, { packages: { "node_modules/a": { version: "1" } } }));
  assert.ok(!npmInstallMatches(lock, { packages: {} }), "a pinned package is missing");
  assert.ok(!npmInstallMatches(lock, { packages: { "node_modules/a": { version: "2" } } }), "wrong version");
  assert.ok(
    !npmInstallMatches(lock, { packages: { "node_modules/a": { version: "1" }, "node_modules/z": { version: "1" } } }),
    "something extra is installed",
  );
  assert.ok(!npmInstallMatches({}, { packages: {} }));
});

test("store: new tasks get a t- id and can be found without the prefix", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "crane-")), "t.db"));
  const r = store.addRepo({ path: "/code/x" });
  const t = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: r.id, autonomy: "observe" });
  assert.match(t.id, /^t-/);
  assert.equal(store.getTask(t.id.slice(2))?.id, t.id);
  store.close();
});

test("store: a database from before the rename keeps its missions as tasks", () => {
  const file = join(mkdtempSync(join(tmpdir(), "crane-")), "old.db");
  const old = new Database(file);
  old.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL DEFAULT 'main', is_factory INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL);
    CREATE TABLE missions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
      repo_id TEXT REFERENCES repos(id), autonomy TEXT NOT NULL, status TEXT NOT NULL, agent_id TEXT, branch TEXT,
      worktree TEXT, report TEXT, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE INDEX missions_status ON missions(status);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id),
      ts TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
    CREATE INDEX events_mission ON events(mission_id, id);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle', mission_id TEXT,
      driver TEXT NOT NULL, missions_completed INTEGER NOT NULL DEFAULT 0, last_active_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO repos VALUES ('r-abcd', 'x', '/code/x', 'main', 0, '2026-01-01T00:00:00Z');
    INSERT INTO missions(id, kind, title, brief, repo_id, autonomy, status, created_at)
      VALUES ('m-old123', 'maintenance', 'Old work', '', 'r-abcd', 'observe', 'needs_review', '2026-01-01T00:00:00Z');
    INSERT INTO events(mission_id, ts, type, message) VALUES ('m-old123', '2026-01-01T00:00:00Z', 'status', 'Queued');
    INSERT INTO agents(id, name, mission_id, driver, missions_completed) VALUES ('a-jib', 'Jib', 'm-old123', 'simulated', 7);
  `);
  old.close();

  const store = new Store(file);
  const t = store.getTask("old123");
  assert.equal(t?.id, "m-old123");
  assert.equal(t?.title, "Old work");
  assert.equal(t?.model, null);
  assert.equal(t?.effort, null);
  assert.equal(store.listEvents("m-old123")[0]?.taskId, "m-old123");
  assert.deepEqual(
    store.listAgents().map((a) => [a.taskId, a.tasksCompleted]),
    [["m-old123", 7]],
  );
  // New work lands in the same table, and events still point at their task.
  const next = store.createTask({ kind: "maintenance", title: "New", brief: "", repoId: "r-abcd", autonomy: "observe" });
  assert.equal(store.listTasks().length, 2);
  assert.equal(store.listEvents(next.id).length, 1);
  assert.equal(store.overview({ running: false, paused: false, driver: "simulated", factoryOutdated: false, uiOutdated: false, uiBuild: null, uiCommit: null }).counts.needs_review, 1);
  store.close();

  // Opening it again is a no-op.
  const again = new Store(file);
  assert.equal(again.listTasks().length, 2);
  again.close();
});
