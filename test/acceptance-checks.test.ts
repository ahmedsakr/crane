import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceCheckRun, unmetAcceptance, validateGoalPlan, type NewTask, type Report, type ValidationRun, type VisualReview } from "@crane/contracts";
import { parseReport } from "@crane/agent-protocol";
import { SimulatedDriver } from "@crane/agent-drivers";
import { Store } from "@crane/storage";
import { OperatorActions } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import { systemPrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";
import { sh } from "./support/git.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-accept-checks-home-"));

const CANDIDATE = "c".repeat(40);
const STALE = "a".repeat(40);
const TEST = "npm test";
const TYPECHECK = "npm run typecheck";

const run = (command: string | null, extra: Partial<ValidationRun> = {}): ValidationRun =>
  ({ phase: "review", commit: CANDIDATE, command, status: "passed", exitCode: 0, logs: "", durationMs: 1, ...extra });

const candidate = (extra: Partial<VisualReview> = {}): VisualReview =>
  ({ status: "not_required", commit: CANDIDATE, tree: "t".repeat(40), note: "Backend only", decidedAt: null, ...extra });

const report = (validation: ValidationRun[], extra: Partial<Report> = {}): Report => ({ summary: "Done", findings: [], changedFiles: [],
  completion: { status: "completed", reason: "Implemented", evidence: "Tests" }, hasContribution: true, validation, ...extra });

function setup() {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  store.setRepoChecks(repo.id, [TYPECHECK, TEST]);
  const make = (extra: Partial<NewTask> = {}) =>
    actions.createTask({ kind: "maintenance", title: "Task", brief: "Do it", repoId: repo.id, autonomy: "propose", preApprove: true, ...extra });
  return { store, actions, repo, make };
}

test("acceptance checks: only a passing review result for the exact candidate and command meets one", () => {
  const unmet = (validation: ValidationRun[], visualReview: VisualReview | null = candidate()) =>
    unmetAcceptance({ acceptance: [], acceptanceChecks: [TEST], report: report(validation), visualReview });

  assert.deepEqual(unmet([]), [TEST], "pending until Crane has run it");
  assert.deepEqual(unmet([run(TEST)]), []);
  assert.deepEqual(unmet([run(TYPECHECK)]), [TEST], "another command doesn't count");
  assert.deepEqual(unmet([run(`${TEST} -- --only=one`)]), [TEST], "commands match exactly");
  assert.deepEqual(unmet([run(null)]), [TEST], "a configuration result names no command");
  assert.deepEqual(unmet([run(TEST, { status: "failed", exitCode: 1 })]), [TEST]);
  assert.deepEqual(unmet([run(TEST, { status: "blocked", exitCode: 126 })]), [TEST]);
  assert.deepEqual(unmet([run(TEST, { status: "unconfigured", exitCode: null })]), [TEST]);
  assert.deepEqual(unmet([run(TEST, { commit: STALE })]), [TEST], "a pass on an earlier candidate is stale");
  assert.deepEqual(unmet([run(TEST, { phase: "merge" })]), [TEST], "merge checks answer a different candidate");
  assert.deepEqual(unmet([run(TEST)], null), [TEST], "no recorded candidate fails closed");

  assert.deepEqual(unmet([run(TEST), run(TEST, { status: "failed", exitCode: 1 })]), [TEST], "the latest result stands");
  assert.deepEqual(unmet([run(TEST, { status: "failed", exitCode: 1 }), run(TEST)]), [], "a rerun can pass");
  assert.deepEqual(unmet([run(TEST, { status: "failed", exitCode: 1, commit: STALE }), run(TEST)]), [], "earlier candidates are ignored either way");
});

test("acceptance checks: the candidate stays the task branch once a merge candidate records its own commit", () => {
  const merged = candidate({ commit: "d".repeat(40), branchCommit: CANDIDATE });
  const task = { report: report([run(TEST)]), visualReview: merged };
  assert.equal(acceptanceCheckRun(task, TEST)?.status, "passed");
});

test("acceptance checks: criterion text is never read as a check, and an unmet criterion still holds", () => {
  const combined = "npm run typecheck and npm test pass";
  const validation = [run(TYPECHECK), run(TEST)];
  assert.deepEqual(unmetAcceptance({ acceptance: [combined], acceptanceChecks: [], report: report(validation), visualReview: candidate() }), [combined],
    "passing checks don't answer free text, however it's worded");
  assert.deepEqual(unmetAcceptance({ acceptance: [TEST], acceptanceChecks: [], report: report(validation), visualReview: candidate() }), [TEST],
    "not even text identical to a command");

  const reported = report(validation, { acceptance: [{ criterion: "Retries back off", met: false, evidence: "Not implemented" }] });
  assert.deepEqual(unmetAcceptance({ acceptance: ["Retries back off"], acceptanceChecks: [TEST], report: reported, visualReview: candidate() }), ["Retries back off"],
    "a passing check doesn't excuse an agent's unmet implementation criterion");
});

test("acceptance checks: agents can't supply the results that meet them", () => {
  const parsed = parseReport("```crane-report\n" + JSON.stringify({ summary: "s", validation: [run(TEST)], acceptance: [{ criterion: TEST, met: true, evidence: "trust me" }] }) + "\n```");
  assert.equal(parsed.validation, undefined);
  assert.deepEqual(unmetAcceptance({ acceptance: [], acceptanceChecks: [TEST], report: parsed, visualReview: candidate() }), [TEST],
    "the agent's own claim about the command isn't evidence");
});

test("acceptance checks: a pre-approved task is held while pending, and merges once Crane's results satisfy them", () => {
  const { store, make } = setup();
  try {
    const finish = (validation: ValidationRun[], extra: Partial<Report> = {}, acceptance: string[] = []) => {
      const t = make({ acceptance, acceptanceChecks: [TYPECHECK, TEST] });
      store.claimNextTask("a-jib");
      store.updateTask(t.id, { branch: `crane/${t.id}`, report: report(validation, extra), visualReview: candidate() });
      return { id: t.id, next: store.finishWork(t.id, "needs_review") };
    };

    const pending = finish([run(TYPECHECK)]);
    assert.equal(pending.next, "needs_review");
    assert.deepEqual(store.listEvents(pending.id).at(-1)?.data?.acceptanceUnmet, [TEST]);

    assert.equal(finish([run(TYPECHECK), run(TEST)]).next, "merging", "the case the post-mortem found: Crane's own passes are enough");
    assert.equal(finish([run(TYPECHECK), run(TEST, { status: "failed", exitCode: 1 })]).next, "needs_review");
    assert.equal(finish([run(TYPECHECK, { commit: STALE }), run(TEST, { commit: STALE })]).next, "needs_review", "stale results");

    assert.equal(finish([run(TYPECHECK), run(TEST)], { acceptance: [{ criterion: "Retries back off", met: false, evidence: "No" }] }, ["Retries back off"]).next,
      "needs_review", "an agent's unmet implementation criterion still holds it");
    assert.equal(finish([run(TYPECHECK), run(TEST)], { completion: { status: "incomplete", reason: "Half done", evidence: "" } }).next,
      "needs_review", "a completion hold still applies");
  } finally { store.close(); }
});

test("acceptance checks: they must name configured checks, on work Crane checks, and a retry keeps them", () => {
  const { store, actions, make } = setup();
  try {
    assert.throws(() => make({ acceptanceChecks: ["npm run lint"] }), /isn't one of this repo's checks/);
    assert.throws(() => make({ acceptanceChecks: [42 as unknown as string] }), /list of commands/);
    assert.throws(() => make({ preApprove: false, autonomy: "observe", acceptanceChecks: [TEST] }), /investigate-only, so Crane runs no checks/);

    const t = make({ acceptanceChecks: [` ${TEST} `, "", TEST] });
    assert.deepEqual(t.acceptanceChecks, [TEST], "trimmed and deduplicated");
    assert.deepEqual(make().acceptanceChecks, []);
    assert.deepEqual(store.getTask(t.id)?.acceptance, [], "kept apart from criteria");

    store.setStatus(t.id, "cancelled");
    assert.deepEqual(actions.retry(t.id).acceptanceChecks, [TEST]);

    store.updateTask(t.id, { report: report([], { findings: [{ title: "More", detail: "More", impact: "low", effort: "small" }] }) });
    assert.deepEqual(actions.followUp(t.id, 0, { acceptanceChecks: [TEST] }).acceptanceChecks, [TEST]);
    assert.throws(() => actions.followUp(t.id, 0, { acceptanceChecks: ["npm run lint"] }), /isn't one of this repo's checks/);
  } finally { store.close(); }
});

test("acceptance checks: goal plans carry them through approval, and approval rejects unconfigured commands", () => {
  const { store, actions, repo } = setup();
  try {
    const item = { key: "only", title: "Only", brief: "Do it", dependsOn: [], driver: "codex", model: null, effort: "high", rationale: "Why", acceptance: ["It works"] };
    const plan = { summary: "S", approach: "A", improvements: [], tasks: [{ ...item, acceptanceChecks: [TEST] }] };
    assert.deepEqual(validateGoalPlan(plan).tasks[0]!.acceptanceChecks, [TEST]);
    assert.deepEqual(validateGoalPlan({ ...plan, tasks: [item] }).tasks[0]!.acceptanceChecks, [], "older plans have none");
    assert.throws(() => validateGoalPlan({ ...plan, tasks: [{ ...item, acceptanceChecks: TEST }] }), /Acceptance checks must be a list/);

    const ready = (tasks: unknown[]) => {
      const goal = actions.createGoal({ outcome: "Ship it", repoId: repo.id });
      store.updateTask(goal.researchTaskId, { status: "needs_review", report: { summary: "Planned", findings: [], changedFiles: [],
        completion: { status: "completed", reason: "Researched", evidence: "Read the repo" }, goalPlan: { ...plan, tasks } } });
      store.syncGoals();
      return store.getGoal(goal.id)!;
    };
    const rejected = ready([{ ...item, acceptanceChecks: ["npm run lint"] }]);
    assert.throws(() => actions.approveGoal(rejected.id, rejected.revision), /requires “npm run lint”, which isn't one of this repo's checks/);

    const good = ready(plan.tasks);
    const approved = actions.approveGoal(good.id, good.revision);
    assert.deepEqual(store.getTask(approved.tasks[0]!.taskId)?.acceptanceChecks, [TEST]);
  } finally { store.close(); }
});

test("acceptance checks: agents are told Crane resolves them, without loosening what they report", () => {
  const { store, make } = setup();
  try {
    const t = make({ acceptance: ["It works"], acceptanceChecks: [TEST] });
    const prompt = userPrompt(t);
    assert.match(prompt, /## Checks Crane must see pass/);
    assert.match(prompt, /`npm test`/);
    assert.match(prompt, /Don't list them in your report's `acceptance` array/);
    assert.match(prompt, /If one isn't met, or you couldn't check it, report `met: false`/, "criteria still report honestly");
    assert.doesNotMatch(userPrompt(make()), /Checks Crane must see pass/, "only when there are some");
    assert.doesNotMatch(systemPrompt(make({ acceptanceChecks: [TEST] }), null), /"acceptance"/, "no agent report is asked for");
  } finally { store.close(); }
});

test("acceptance checks: a real run with no agent evidence merges on Crane's results, and a stale pass doesn't count", async () => {
  const root = mkdtempSync(join(tmpdir(), "crane-accept-checks-"));
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  sh(checkout, "add", "README.md");
  sh(checkout, "commit", "-q", "-m", "start");
  const store = new Store(join(root, "crane.db"));
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "accept-checks");
  store.setRepoChecks(repo.id, ["true"]);
  const task = actions.createTask({ kind: "maintenance", title: "Fix the retries", brief: "", repoId: repo.id, autonomy: "propose", preApprove: true, acceptanceChecks: ["true"] });
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    for (let i = 0; i < 1500 && !["merged", "needs_review", "failed"].includes(store.getTask(task.id)!.status); i++) await new Promise((r) => setTimeout(r, 10));
    const done = store.getTask(task.id)!;
    assert.equal(done.status, "merged", store.listEvents(task.id).map((e) => e.message).join("\n"));
    assert.deepEqual(unmetAcceptance(done), []);
    assert.ok(!store.listEvents(task.id).some((e) => e.data?.acceptanceUnmet), "never held");
    assert.deepEqual(unmetAcceptance({ ...done, visualReview: candidate({ commit: STALE }) }), ["true"], "the same results don't answer a different candidate");
  } finally {
    await factory.stop();
    store.close();
  }
});
