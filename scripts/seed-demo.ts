/**
 * Fill a Crane home with a week of sample history so the dashboard has something
 * to show. Creates two throwaway git repos inside CRANE_HOME. Never run this
 * against your real Crane home:
 *
 *   CRANE_HOME=/tmp/crane-demo npx tsx scripts/seed-demo.ts
 *   CRANE_HOME=/tmp/crane-demo npx tsx src/cli/index.ts serve --driver simulated
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { craneHome } from "../src/core/paths.js";
import { OperatorActions } from "../src/factory/actions.js";
import type { TaskKind, Autonomy } from "../src/core/types.js";

if (!process.env.CRANE_HOME) {
  console.error("Set CRANE_HOME to a scratch directory first. This script writes sample data.");
  process.exit(1);
}

const home = craneHome();
const store = new Store();
const actions = new OperatorActions(store);
await actions.ensureFactoryRepo();

function makeRepo(name: string) {
  const dir = join(home, "demo-repos", name);
  if (!existsSync(dir)) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    writeFileSync(join(dir, "src", "index.ts"), "export const hello = () => 'world';\n");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    g("init", "-q", "-b", "main");
    g("add", ".");
    g("-c", "user.name=demo", "-c", "user.email=demo@localhost", "commit", "-qm", "init");
  }
  return store.addRepo({ path: dir, name, defaultBranch: "main" });
}

const api = makeRepo("payments-api");
const web = makeRepo("storefront");

const history: [TaskKind, string, string, Autonomy][] = [
  ["maintenance", "Upgrade the Stripe SDK to v18", api.id, "propose"],
  ["maintenance", "Fix flaky checkout timeout test", api.id, "propose"],
  ["maintenance", "Audit dependencies for advisories", web.id, "observe"],
  ["repo_feature", "Research idempotency keys for refunds", api.id, "observe"],
  ["maintenance", "Remove dead feature flags", web.id, "propose"],
  ["repo_feature", "Add saved carts behind a flag", web.id, "propose"],
  ["maintenance", "Speed up the CI test matrix", api.id, "act"],
  ["maintenance", "Tighten CSP headers", web.id, "propose"],
  ["factory_feature", "Research task priorities for the queue", store.listRepos().find((r) => r.isFactory)!.id, "observe"],
  ["maintenance", "Fix N+1 query on order history", api.id, "propose"],
  ["repo_feature", "Research Apple Pay on web", web.id, "observe"],
  ["maintenance", "Bump Node to 22 in Dockerfiles", api.id, "act"],
];

const hour = 3600_000;
const now = Date.now();
let n = 0;
for (let day = 6; day >= 0; day--) {
  const perDay = 2 + ((day * 7) % 4);
  for (let i = 0; i < perDay; i++) {
    const [kind, title, repoId, autonomy] = history[n++ % history.length]!;
    const m = store.createTask({ kind, title, brief: title, repoId, autonomy });
    const start = now - day * 24 * hour - (9 + i * 3) * hour + Math.random() * hour;
    const end = start + (8 + Math.random() * 40) * 60_000;
    if (end > now) continue;
    const iso = (t: number) => new Date(t).toISOString();
    store.updateTask(m.id, {
      status: autonomy === "propose" ? "approved" : "done",
      startedAt: iso(start),
      finishedAt: iso(end),
      costUsd: 0,
      report: { summary: "Sample history for the demo.", findings: [], changedFiles: [] },
    });
    store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(iso(start - 60_000), m.id);
    store.db.prepare("DELETE FROM events WHERE task_id = ?").run(m.id);
    const steps = 12 + Math.floor(Math.random() * 30);
    const ins = store.db.prepare("INSERT INTO events(task_id, ts, type, message) VALUES(?, ?, ?, ?)");
    for (let s = 0; s < steps; s++) ins.run(m.id, iso(start + ((end - start) * s) / steps), s % 3 ? "tool" : "note", "Sample step");
  }
}

// Fresh work for the simulated crew to pick up.
store.createTask({ kind: "maintenance", title: "Investigate the flaky webhook retry tests", brief: "Investigate the flaky webhook retry tests in payments-api", repoId: api.id, autonomy: "observe" });
store.createTask({ kind: "repo_feature", title: "Add a dark mode toggle to the storefront header", brief: "Add a dark mode toggle to the storefront header", repoId: web.id, autonomy: "propose" });
store.createTask({ kind: "maintenance", title: "Find unused exports across the storefront", brief: "Find unused exports across the storefront", repoId: web.id, autonomy: "observe" });

console.log(`Seeded ${n} historical tasks and 3 queued ones into ${home}`);
store.close();
