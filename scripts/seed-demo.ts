import "../src/application.js";
/**
 * Fill a Crane home with three weeks of sample history so the dashboard has something
 * to show. Creates two throwaway git repos inside CRANE_HOME. Never run this
 * against your real Crane home:
 *
 *   CRANE_HOME=/tmp/crane-demo npx tsx scripts/seed-demo.ts
 *   CRANE_HOME=/tmp/crane-demo npx tsx src/cli/index.ts serve --driver simulated
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "@crane/storage";
import { craneHome } from "@crane/backend-runtime";
import { OperatorActions } from "@crane/factory/actions";
import { withActor } from "@crane/backend-runtime";
import type { TaskKind, Autonomy, TaskStatus, EventActor } from "@crane/contracts";

if (!process.env.CRANE_HOME) {
  console.error("Set CRANE_HOME to a scratch directory first. This script writes sample data.");
  process.exit(1);
}

const home = craneHome();
const store = new Store();
const actions = new OperatorActions(store);
await actions.ensureFactoryRepo();

// Two invented operators, so the history shows who started and decided things.
// They are snapshots only: no operator accounts exist, so the demo needs no sign-in.
const robin: EventActor = { kind: "operator", id: "op-demo-robin", name: "Robin" };
const kai: EventActor = { kind: "operator", id: "op-demo-kai", name: "Kai" };
const as = <T>(actor: EventActor | null, fn: () => T): T => (actor ? withActor(actor, fn) : fn());

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
// One repo of each wider command access, so the Repos page and simulated runs show both.
actions.setCommandAccess(api.id, "auto");
actions.setCommandAccess(web.id, "most");

/** Refusals shaped like the Claude Code driver's: Crane's guard, for good and until allowed, and auto mode. */
const GUARD_REFUSALS = {
  hard: { tool: "Bash", command: "git branch -f main HEAD", rules: [],
    refusal: { source: "crane.guard", reason: "Changing shared Git state is Crane's job and requires the operator's approval." },
    guard: { category: "shared-git", overridable: false } },
  publish: { tool: "Bash", command: "npm publish --access public", rules: ["Bash(npm publish:*)"],
    refusal: { source: "crane.guard", reason: "Publishing or changing remote resources requires an operator rule for this repository." },
    guard: { category: "publish", overridable: true } },
  autoMode: { tool: "Bash", command: "npm run db:reset", rules: ["Bash(npm run db:reset:*)"],
    refusal: { source: "claude.auto-mode", reason: "Resetting the shared database goes beyond what the task asked for." } },
} as const;

function seedRefusal(taskId: string, at: number, kind: keyof typeof GUARD_REFUSALS) {
  const call = GUARD_REFUSALS[kind];
  store.db.prepare("INSERT INTO events(task_id, ts, type, message, data) VALUES(?, ?, 'blocked', ?, ?)")
    .run(taskId, iso(Math.min(at, now)), `Blocked: ${call.command}`, JSON.stringify({ ...call, toolUseId: `demo-${kind}-${taskId}` }));
}

// Keep every demo assignment simulated, including after the operator approves its plan.
function seedGoal() {
  const goal = actions.createGoal({ repoId: web.id, outcome: "Customers can save a cart and return to it later", driver: "simulated" });
  store.updateTask(goal.researchTaskId, { status: "done", report: {
    summary: "Demo research: a shared storage contract unlocks independent UI and API work.", findings: [], changedFiles: [],
    completion: { status: "completed", reason: "Demo plan ready for review", evidence: "Seeded demo data, not actual repository research" },
    goalPlan: { summary: "Extract cart persistence, build the two entry points in parallel, then verify the complete customer flow.",
      approach: "Demo plan: establish the shared storage contract first so the UI and API use the same semantics. UI and API work can then run together in isolated worktrees; a final integration task checks the outcome after both merge. This is sample data, not repository analysis.",
      improvements: ["Consider consolidating cart and checkout telemetry after delivery."],
      tasks: [
        { key: "storage", title: "Extract the cart persistence contract", dependsOn: [], rationale: "Shared contract refactoring must land before consumers change." },
        { key: "ui", title: "Build the saved carts experience", dependsOn: ["storage"], rationale: "Interaction and accessibility work can run alongside the API." },
        { key: "api", title: "Add saved cart endpoints", dependsOn: ["storage"], rationale: "Focused API work uses the established persistence contract." },
        { key: "integration", title: "Verify the complete saved cart flow", dependsOn: ["ui", "api"], rationale: "Integration follows both delivery branches and fixes any remaining gaps." },
      ].map((t) => ({ ...t, driver: "simulated", model: null, effort: null,
        brief: "This is a demo task for goal orchestration. Write only a simulated note describing the named change.",
        acceptance: ["Simulated note written"] })) },
  } });
  store.syncGoals();
}

/**
 * A goal partway through delivery, one task in each state, so the goal pages have something to
 * show. Only tasks the simulated crew can't claim name a real agent: merged or stopped ones,
 * and one still waiting on a prerequisite.
 */
function seedGoalInProgress() {
  const goal = actions.createGoal({ repoId: api.id, outcome: "Checkout keeps working when the payments service is down", driver: "simulated" });
  const tasks: { key: string; title: string; dependsOn: string[]; driver: string; model: string | null; effort: string | null; status: TaskStatus }[] = [
    { key: "contract", title: "Define the offline charge contract", dependsOn: [], driver: "claude-code", model: "opus", effort: "high", status: "merged" },
    { key: "queue", title: "Queue charges while the service is down", dependsOn: ["contract"], driver: "codex", model: null, effort: "high", status: "merged" },
    { key: "replay", title: "Replay queued charges on recovery", dependsOn: ["queue"], driver: "simulated", model: null, effort: null, status: "running" },
    { key: "banner", title: "Tell shoppers their payment is pending", dependsOn: ["contract"], driver: "simulated", model: null, effort: null, status: "needs_review" },
    { key: "alerts", title: "Page on-call when the queue backs up", dependsOn: ["queue"], driver: "codex", model: "gpt-5-codex", effort: "medium", status: "failed" },
    { key: "verify", title: "Verify an outage from end to end", dependsOn: ["replay", "banner", "alerts"], driver: "claude-code", model: "sonnet", effort: "high", status: "queued" },
  ];
  store.updateTask(goal.researchTaskId, { status: "done", report: {
    summary: "Demo research.", findings: [], changedFiles: [],
    completion: { status: "completed", reason: "Demo plan ready for review", evidence: "Seeded demo data, not actual repository research" },
    goalPlan: { summary: "Queue charges during an outage and replay them on recovery, with shoppers and on-call kept informed.",
      approach: "Demo plan: settle the contract first, then build the queue, and run the visible work alongside it. This is sample data, not repository analysis.",
      improvements: [],
      tasks: tasks.map(({ status: _status, ...t }) => ({ ...t, rationale: "Demo assignment.", brief: "This is a demo task for goal orchestration. Write only a simulated note describing the named change.", acceptance: ["Simulated note written"] })) },
  } });
  store.syncGoals();
  const approved = withActor(kai, () => actions.approveGoal(goal.id, store.getGoal(goal.id)!.revision));
  for (const { key, status } of tasks) {
    if (status !== "queued") store.updateTask(approved.tasks.find((t) => t.key === key)!.taskId, { status });
  }
  store.syncGoals();
}

function seedFinishedGoal() {
  const goal = actions.createGoal({ repoId: web.id, outcome: "Shoppers can pay with Apple Pay on the web", driver: "simulated" });
  store.updateTask(goal.researchTaskId, { status: "done", report: {
    summary: "Demo research.", findings: [], changedFiles: [],
    completion: { status: "completed", reason: "Demo plan ready for review", evidence: "Seeded demo data, not actual repository research" },
    goalPlan: { summary: "Add the Apple Pay button behind the existing payment step.", approach: "Demo plan: one change. This is sample data, not repository analysis.", improvements: [],
      tasks: [{ key: "button", title: "Add the Apple Pay button", dependsOn: [], driver: "simulated", model: null, effort: null, rationale: "Demo assignment.",
        brief: "This is a demo task for goal orchestration. Write only a simulated note describing the named change.", acceptance: ["Simulated note written"] }] },
  } });
  store.syncGoals();
  const approved = actions.approveGoal(goal.id, store.getGoal(goal.id)!.revision);
  for (const { taskId } of approved.tasks) store.updateTask(taskId, { status: "merged" });
  store.syncGoals();
}

// The plan awaiting review comes last, so it's the first goal listed.
seedFinishedGoal();
seedGoalInProgress();
seedGoal();

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
const iso = (t: number) => new Date(t).toISOString();

function historyStatus(n: number, autonomy: Autonomy): TaskStatus {
  if (n % 11 === 0) return "failed";
  if (n % 7 === 0) return "rejected";
  return autonomy === "propose" ? "approved" : "done";
}

/** Every third task has no starter, like one a schedule started. */
function historyStarter(n: number): EventActor | null {
  if (n % 3 === 0) return null;
  return n % 2 ? robin : kai;
}

/** The operator's decision on a reviewed task, made by whoever started it (or Robin). */
function seedDecision(taskId: string, status: TaskStatus, at: number, actor: EventActor | null) {
  if (status !== "approved" && status !== "rejected") return;
  const event = as(actor ?? robin, () => store.addEvent(taskId, "operator", status === "approved" ? "Approved" : "Declined"));
  store.db.prepare("UPDATE events SET ts = ? WHERE id = ?").run(iso(Math.min(at, now)), event.id);
}

function seedHistory() {
  let n = 0;
  for (let day = 20; day >= 0; day--) {
    const perDay = 2 + ((day * 7) % 4);
    for (let i = 0; i < perDay; i++) {
      const [kind, title, repoId, autonomy] = history[n++ % history.length]!;
      const starter = historyStarter(n);
      const m = as(starter, () => store.createTask({ kind, title, brief: title, repoId, autonomy }));
      const start = now - day * 24 * hour - (9 + i * 3) * hour + Math.random() * hour;
      const end = start + (8 + Math.random() * 40) * 60_000;
      if (end > now) continue;
      // A little waste, so the analytics have something to say about it.
      const status = historyStatus(n, autonomy);
      store.updateTask(m.id, {
        status,
        startedAt: iso(start),
        finishedAt: iso(end),
        report: { summary: "Sample history for the demo.", findings: [], changedFiles: [] },
      });
      seedRuns(m.id, { n, start, end, status });
      seedEvents(m.id, { n, start, end, repoId });
      seedDecision(m.id, status, end + 5 * 60_000, starter);
    }
  }
  return n;
}

function seedRuns(taskId: string, { n, start, end, status }: { n: number; start: number; end: number; status: TaskStatus }) {
  // Sample usage, roughly what each agent reports for runs this size. Every third task ran on
  // Codex, which reports tokens but no cost.
  const codex = n % 3 === 0;
  const runs: ["work" | "resolve_conflicts", number][] = [["work", (end - start) / 60_000]];
  if (n % 5 === 0) runs.push(["resolve_conflicts", 3]);
  for (const [kind, minutes] of runs) {
    const run = store.startRun({ taskId, kind, agentId: null, driver: codex ? "codex" : "claude-code" });
    const turns = Math.round(minutes * (1 + Math.random()));
    const tokensIn = turns * 18_000;
    store.finishRun(run, status === "failed" ? "failed" : "succeeded", {
      costUsd: codex ? 0 : +(minutes * (0.03 + Math.random() * 0.05)).toFixed(4),
      inputTokens: Math.round(tokensIn * 0.04),
      cacheReadTokens: Math.round(tokensIn * 0.86),
      cacheWriteTokens: Math.round(tokensIn * 0.1),
      outputTokens: turns * 700,
      turns,
      model: codex ? null : "claude-sonnet-5-5",
    });
    store.db.prepare("UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?").run(iso(start), iso(end), run);
  }
}

function seedEvents(taskId: string, { n, start, end, repoId }: { n: number; start: number; end: number; repoId: string }) {
  store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(iso(start - 60_000), taskId);
  store.db.prepare("DELETE FROM events WHERE task_id = ?").run(taskId);
  const steps = 12 + Math.floor(Math.random() * 30);
  const ins = store.db.prepare("INSERT INTO events(task_id, ts, type, message) VALUES(?, ?, ?, ?)");
  for (let s = 0; s < steps; s++) ins.run(taskId, iso(start + ((end - start) * s) / steps), s % 3 ? "tool" : "note", "Sample step");
  // Agents in payments-api keep reaching for the same two commands.
  if (repoId === api.id && n % 2 === 0) {
    const blocked = store.db.prepare("INSERT INTO events(task_id, ts, type, message, data) VALUES(?, ?, 'blocked', ?, ?)");
    const at = iso(start + (end - start) / 3);
    blocked.run(taskId, at, "Blocked: pnpm audit --prod | tail -20", JSON.stringify({ tool: "Bash", command: "pnpm audit --prod | tail -20", rules: ["Bash(pnpm audit:*)"] }));
    if (n % 4 === 0) {
      blocked.run(taskId, at, "Blocked: docker compose up -d db", JSON.stringify({ tool: "Bash", command: "docker compose up -d db", rules: ["Bash(docker compose:*)"] }));
    }
    // Since the repo widened its commands, Crane's guard keeps refusing a publish the operator hasn't allowed.
    if (n % 3 === 0) seedRefusal(taskId, start + (end - start) / 2, "publish");
  }
}

// Fresh work for the simulated crew to pick up.
function seedQueuedWork() {
  store.createTask({ kind: "maintenance", title: "Investigate the flaky webhook retry tests", brief: "Investigate the flaky webhook retry tests in payments-api", repoId: api.id, autonomy: "observe" });
  withActor(kai, () => store.createTask({ kind: "repo_feature", title: "Add a dark mode toggle to the storefront header", brief: "Add a dark mode toggle to the storefront header", repoId: web.id, autonomy: "propose" }));
  store.createTask({ kind: "maintenance", title: "Find unused exports across the storefront", brief: "Find unused exports across the storefront", repoId: web.id, autonomy: "observe" });
}

// A package split that came back with part of its scope unmet, and the follow-up waiting for it to land.
function seedClientReview() {
  const client = withActor(robin, () => store.createTask({
    kind: "maintenance",
    title: "Extract the payments client into its own package",
    brief: "Move src/client into a packages/client workspace package, and point callers at it.",
    repoId: api.id,
    autonomy: "propose",
    acceptance: ["Callers import @payments/client, not ../client", "npm run build emits packages/client/dist"],
    acceptanceChecks: ["npm test", "npm run typecheck"],
    lookouts: ["refactoring", "test_gaps"],
  }));
  store.updateTask(client.id, {
    status: "needs_review",
    branch: `crane/extract-the-payments-client-${client.id.slice(2)}`,
    startedAt: new Date(now - 50 * 60_000).toISOString(),
    finishedAt: new Date(now - 12 * 60_000).toISOString(),
    report: {
      summary: "Moved the client into packages/client and pointed every caller at it. The workspace build target isn't set up yet, so the package doesn't build on its own. Looking out for refactoring and test gaps turned up two follow-ups.",
      findings: [
        {
          title: "Fold the two retry loops into the client's backoff helper",
          detail: "src/webhooks/retry.ts and src/checkout/charge.ts each carry their own copy of the exponential backoff loop. Both could call `withBackoff` from @payments/client.",
          impact: "medium",
          effort: "small",
        },
        {
          title: "Test the client's timeout path",
          detail: "No test covers a request that times out, so the retry-on-timeout branch in packages/client/src/index.ts is unexercised.",
          impact: "medium",
          effort: "small",
        },
      ],
      changedFiles: ["packages/client/package.json", "packages/client/src/index.ts", "src/checkout/charge.ts", "src/webhooks/retry.ts"],
      acceptance: [
        { criterion: "Callers import @payments/client, not ../client", met: true, evidence: "rg '../client' src returns nothing; 14 imports of @payments/client" },
        { criterion: "npm run build emits packages/client/dist", met: false, evidence: "The root build doesn't include the workspace yet. That needs the shared build setup." },
      ],
    },
  });
  const branch = store.getTask(client.id)!.branch!;
  seedClientBranch(api.path, branch);
  // Each kind of refusal from the run, so the task page shows how they read.
  seedRefusal(client.id, now - 40 * 60_000, "hard");
  seedRefusal(client.id, now - 30 * 60_000, "publish");
  seedRefusal(client.id, now - 20 * 60_000, "autoMode");
  // Crane's own results on the real candidate: one required check passed, the other never ran.
  const commit = execFileSync("git", ["rev-parse", branch], { cwd: api.path, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", `${branch}^{tree}`], { cwd: api.path, encoding: "utf8" }).trim();
  store.updateTask(client.id, {
    visualReview: { status: "pending", commit, tree, note: "The agent did not classify visual review; operator review is required.", decidedAt: null },
    report: { ...store.getTask(client.id)!.report!, validation: [{ phase: "review", commit, command: "npm test", status: "passed", exitCode: 0, logs: "All tests passed", durationMs: 41_000 }] },
  });
  return client;
}

/** Real commits behind the review task's branch, so its changes have something to show. */
function seedClientBranch(dir: string, branch: string) {
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@localhost", ...a], { cwd: dir, stdio: "ignore" });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const backoff = (name: string, call: string) =>
    [
      `export async function ${name}(attempts = 5) {`,
      "  let delay = 200;",
      "  for (let i = 0; i < attempts; i++) {",
      "    try {",
      `      return await ${call};`,
      "    } catch (err) {",
      "      if (i === attempts - 1) throw err;",
      "      await new Promise((r) => setTimeout(r, delay));",
      "      delay *= 2;",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
  const client = [
    "const BASE = process.env.PAYMENTS_URL ?? 'https://payments.internal';",
    "",
    "export async function request(path: string, body: unknown) {",
    "  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });",
    "  if (!res.ok) throw new Error(`${path} failed with ${res.status}`);",
    "  return res.json();",
    "}",
    "",
  ].join("\n");
  if (!existsSync(join(dir, "src", "client", "index.ts"))) {
    write("src/client/index.ts", client);
    write("src/webhooks/retry.ts", `import { request } from "../client";\n\n${backoff("redeliver", "request('/webhooks/redeliver', {})")}`);
    write("src/checkout/charge.ts", `import { request } from "../client";\n\n${backoff("charge", "request('/charges', {})")}`);
    g("add", ".");
    g("commit", "-qm", "Add the payments client and its callers");
  }
  g("checkout", "-q", "-B", branch);
  mkdirSync(join(dir, "packages", "client", "src"), { recursive: true });
  g("mv", "src/client/index.ts", "packages/client/src/index.ts");
  write(
    "packages/client/src/index.ts",
    client.replace("export async function request", "/** Calls the payments service, retrying with exponential backoff. */\nexport async function request") +
      "\n" + backoff("withBackoff", "fn()").replace("withBackoff(attempts = 5)", "withBackoff<T>(fn: () => Promise<T>, attempts = 5)"),
  );
  write("packages/client/package.json", JSON.stringify({ name: "@payments/client", version: "0.1.0", main: "src/index.ts" }, null, 2) + "\n");
  write("src/webhooks/retry.ts", `import { request, withBackoff } from "@payments/client";\n\nexport const redeliver = () => withBackoff(() => request("/webhooks/redeliver", {}));\n`);
  write("src/checkout/charge.ts", `import { request, withBackoff } from "@payments/client";\n\nexport const charge = (attempts = 5) => withBackoff(() => request("/charges", {}), attempts);\n`);
  g("add", "-A");
  g("commit", "-qm", "Extract the payments client into its own package");
  g("checkout", "-q", "main");
}

function seedClientFollowUps(client: ReturnType<typeof seedClientReview>) {
  store.createTask({
    kind: "maintenance",
    title: "Move webhook handlers onto the payments client package",
    brief: "Once the client package lands, move the webhook handlers onto its public API.",
    repoId: api.id,
    autonomy: "propose",
    prerequisites: [client.id],
    acceptance: ["src/webhooks imports only from @payments/client's entry point", "The webhook retry tests pass"],
  });

  // A follow-up the operator started from the review task's second finding.
  const finding = store.getTask(client.id)!.report!.findings[1]!;
  store.createTask({
    kind: "maintenance",
    title: finding.title,
    brief: `${finding.detail}\n\nFollow-up to task ${client.id}: “${client.title}”.`,
    repoId: api.id,
    autonomy: "propose",
    followUp: { of: client.id, finding: 1 },
  });
}

const n = seedHistory();
seedQueuedWork();
const client = seedClientReview();
seedClientFollowUps(client);

// One crew member dedicated to security reviews of Crane, waiting for the operator to start one.
store.setSetting("crew_role_a-hoist", "security");
store.setSetting("crew_active_a-hoist", "true");

console.log(`Seeded ${n} historical tasks, 5 queued ones (one waiting on a prerequisite, one a follow-up), and 1 for review into ${home}`);
store.close();
