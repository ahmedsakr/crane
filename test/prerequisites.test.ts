import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prerequisiteMet, unmetAcceptance, type Autonomy, type NewTask, type Report } from "@crane/contracts";
import { parseReport, type AgentDriver, type RunContext } from "@crane/agent-protocol";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import { createApp } from "../src/server/app.js";
import { systemPrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-prereq-home-"));

function setup() {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  const other = store.addRepo({ path: "/other" });
  const make = (extra: Partial<NewTask> = {}, autonomy: Autonomy = "propose") =>
    actions.createTask({ kind: "maintenance", title: "Task", brief: "Do it", repoId: repo.id, autonomy, ...extra });
  return { store, actions, repo, other, make };
}

const report = (acceptance?: Report["acceptance"]): Report => ({ summary: "Done", findings: [], changedFiles: [], acceptance,
  completion: { status: "completed", reason: "Implemented", evidence: "Implementation tests" }, hasContribution: true });

test("prerequisites: landed means merged, or finished with nothing left to merge", () => {
  assert.equal(prerequisiteMet({ status: "merged", branch: "crane/x" }), true);
  assert.equal(prerequisiteMet({ status: "done", branch: null }), true);
  assert.equal(prerequisiteMet({ status: "approved", branch: null }), true);
  for (const status of ["queued", "running", "needs_review", "merging", "failed", "cancelled", "rejected"] as const) {
    assert.equal(prerequisiteMet({ status, branch: null }), false, status);
  }
  assert.equal(prerequisiteMet({ status: "approved", branch: "crane/kept" }), false, "an approved branch kept unmerged hasn't landed");
  assert.equal(prerequisiteMet({ status: "done", branch: "crane/kept" }), false);
});

test("prerequisites: a queued task waits until they land, and others run past it", () => {
  const { store, make } = setup();
  try {
    const protocol = make({ title: "Create @crane/agent-protocol" });
    store.setStatus(protocol.id, "merging");
    const policy = make({ title: "Create @crane/agent-policy", prerequisites: [protocol.id] });
    const later = make({ title: "Unrelated" });
    assert.ok(store.listEvents(policy.id).some((e) => e.message === `Waits for ${protocol.id} to land before it starts`));

    // The protocol task itself is merging, not queued, so the next claim skips the held task.
    assert.equal(store.claimNextTask("a-jib")?.id, later.id);
    assert.equal(store.claimNextTask("a-boom"), null, "held while its prerequisite is still merging");
    assert.equal(store.getTask(policy.id)!.status, "queued");

    store.setStatus(protocol.id, "merged");
    assert.equal(store.claimNextTask("a-boom")?.id, policy.id);
  } finally { store.close(); }
});

test("prerequisites: checked when the task is made, in the same repo, and kept by a retry", () => {
  const { store, actions, repo, other, make } = setup();
  try {
    const first = make();
    assert.throws(() => make({ prerequisites: ["t-nope"] }), /No task t-nope to wait for/);
    const elsewhere = actions.createTask({ kind: "maintenance", title: "Elsewhere", brief: "", repoId: other.id, autonomy: "propose" });
    assert.throws(() => make({ prerequisites: [elsewhere.id] }), /in another repo/);
    assert.throws(() => make({ prerequisites: "t-1" as unknown as string[] }), /list of task ids/);
    assert.throws(() => make({ acceptance: [42 as unknown as string] }), /list of text/);
    assert.throws(() => make({ acceptance: ["x".repeat(501)] }), /under 500 characters/);
    assert.throws(() => make({ acceptance: Array.from({ length: 21 }, (_, i) => `c${i}`) }), /at most 20/);

    const bare = first.id.replace(/^t-/, "");
    const t = make({ prerequisites: [bare, ` ${first.id} `, ""], acceptance: ["  npm test   passes ", "", "npm test passes"] });
    assert.deepEqual(t.prerequisites, [first.id], "resolved, trimmed, and deduplicated");
    assert.deepEqual(t.acceptance, ["npm test passes"]);
    assert.equal(make().prerequisites.length, 0);

    store.setStatus(t.id, "cancelled");
    const again = actions.retry(t.id);
    assert.deepEqual(again.prerequisites, [first.id]);
    assert.deepEqual(again.acceptance, ["npm test passes"]);
    assert.equal(again.prerequisitesWaivedAt, null);
    assert.equal(store.getTask(again.id)!.repoId, repo.id);
  } finally { store.close(); }
});

test("prerequisites: the operator can waive them for a queued task, once, and it then starts", () => {
  const { store, actions, make } = setup();
  try {
    const prerequisite = make();
    store.setStatus(prerequisite.id, "running");
    const free = make();
    assert.throws(() => actions.waivePrerequisites(free.id), /isn't waiting for any prerequisites/);

    const held = make({ prerequisites: [prerequisite.id] });
    assert.throws(() => actions.waivePrerequisites(held.id, 42 as unknown as string), /Note must be text/);
    const waived = actions.waivePrerequisites(held.id, "Ship the in-tree module now");
    assert.ok(waived.prerequisitesWaivedAt);
    const event = store.listEvents(held.id).at(-1)!;
    assert.equal(event.type, "operator");
    assert.equal(event.message, `Waived prerequisites ${prerequisite.id}: Ship the in-tree module now`);
    assert.deepEqual(event.data?.waived, [prerequisite.id]);
    assert.throws(() => actions.waivePrerequisites(held.id), /already waived/);

    store.setStatus(free.id, "cancelled");
    assert.equal(store.claimNextTask("a-jib")?.id, held.id, "starts despite the unmet prerequisite");

    const cancelled = make({ prerequisites: [prerequisite.id] });
    store.setStatus(cancelled.id, "cancelled");
    assert.throws(() => actions.waivePrerequisites(cancelled.id), /isn't queued/);
    assert.equal(store.getTask(cancelled.id)!.prerequisitesWaivedAt, null);
  } finally { store.close(); }
});

test("acceptance: a pre-approved task merges on its own only when every criterion is reported met", () => {
  const { store, actions, make } = setup();
  const finish = (acceptance: string[], results?: Report["acceptance"]) => {
    const t = make({ acceptance });
    actions.preApprove(t.id);
    store.claimNextTask("a-jib");
    store.updateTask(t.id, { branch: `crane/${t.id}`, report: report(results), visualReview: { status: "not_required", commit: "test", tree: "test", note: "No UI changes", decidedAt: null } });
    return { id: t.id, next: store.finishWork(t.id, "needs_review") };
  };
  try {
    const criteria = ["Callers import @crane/agent-protocol", "npm run build emits packages/agent-policy/dist"];

    const reduced = finish(criteria, [
      { criterion: criteria[0]!, met: true, evidence: "grep shows no relative imports" },
      { criterion: criteria[1]!, met: false, evidence: "The workspace package is future work" },
    ]);
    assert.equal(reduced.next, "needs_review", "unfinished scope waits for the operator, even though checks passed");
    const event = store.listEvents(reduced.id).at(-1)!;
    assert.match(event.message, /^Pre-approved, but the report doesn't show an acceptance criterion met/);
    assert.deepEqual(event.data?.acceptanceUnmet, [criteria[1]]);

    assert.equal(finish(criteria, [{ criterion: criteria[0]!, met: true, evidence: "" }]).next, "needs_review", "unreported counts as unmet");
    assert.equal(finish(criteria).next, "needs_review", "no acceptance in the report at all");

    const contradictory = finish([criteria[0]!], [
      { criterion: criteria[0]!, met: true, evidence: "" },
      { criterion: criteria[0]!, met: false, evidence: "actually not" },
    ]);
    assert.equal(contradictory.next, "needs_review", "an unmet entry wins over a met one");

    const done = finish(criteria, [
      { criterion: `  ${criteria[0]!.toLowerCase()} `, met: true, evidence: "" },
      { criterion: criteria[1]!, met: true, evidence: "ls packages/agent-policy/dist" },
    ]);
    assert.equal(done.next, "merging", "matched by text, ignoring case and spacing");
    assert.equal(finish([]).next, "merging", "no criteria: pre-approval works as before");
  } finally { store.close(); }
});

test("acceptance: reports carry only literal met: true, and missing reports mean unmet", () => {
  const text = (body: unknown) => "Done.\n\n```crane-report\n" + JSON.stringify(body) + "\n```";
  const parsed = parseReport(text({
    summary: "s",
    acceptance: [
      { criterion: "A", met: true, evidence: "ran it" },
      { criterion: "B", met: "true", evidence: 7 },
      { criterion: 3, met: true },
      null,
    ],
  }));
  assert.deepEqual(parsed.acceptance, [
    { criterion: "A", met: true, evidence: "ran it" },
    { criterion: "B", met: false, evidence: "7" },
  ]);
  assert.equal(parseReport(text({ summary: "s" })).acceptance, undefined);
  assert.deepEqual(unmetAcceptance({ acceptance: ["A", "B"], acceptanceChecks: [], report: parsed }), ["B"]);
  assert.deepEqual(unmetAcceptance({ acceptance: ["A"], acceptanceChecks: [], report: null }), ["A"]);
  assert.deepEqual(unmetAcceptance({ acceptance: [], acceptanceChecks: [], report: null }), []);
});

test("prompts: prerequisites and acceptance criteria read as gates, and a waiver says the scope is reduced", () => {
  const { store, make } = setup();
  try {
    const protocol = make({ title: "Create @crane/agent-protocol" });
    const t = make({ prerequisites: [protocol.id], acceptance: ["packages/agent-policy builds on its own"] });
    store.setStatus(protocol.id, "merged");
    const landed = userPrompt(t, undefined, { prerequisites: store.prerequisiteStates(t) });
    assert.match(landed, /## Prerequisites/);
    assert.match(landed, new RegExp(`- ${protocol.id}: Create @crane/agent-protocol \\(Merged, landed\\)`));
    assert.match(landed, /only after these tasks landed/);
    assert.match(landed, /do not substitute a smaller or different scope/);
    assert.match(landed, /## Acceptance criteria/);
    assert.match(landed, /1\. packages\/agent-policy builds on its own/);
    assert.match(landed, /copy the criterion's text exactly/);
    assert.match(landed, /generic checks does not by itself show a criterion is met/);
    assert.match(systemPrompt(t, null), /"acceptance": \[/, "the report shape asks for acceptance");
    assert.doesNotMatch(systemPrompt(make(), null), /"acceptance"/, "only when there are criteria");
    assert.ok(userPrompt(make()).startsWith("# Task\n\nDo it\n\n## Current visual-decision context"));
    assert.doesNotMatch(userPrompt(make()), /## Prerequisites|## Acceptance criteria/, "no gates");

    const waiting = make({ prerequisites: [make().id] });
    store.waivePrerequisites(waiting.id);
    const waived = userPrompt(store.getTask(waiting.id)!, undefined, { prerequisites: store.prerequisiteStates(waiting) });
    assert.match(waived, /waived the prerequisites that hadn't landed and approved a reduced scope/);
    assert.match(waived, /report each part that still does as unfinished scope/);
    assert.match(waived, /\(Queued, not landed\)/);
  } finally { store.close(); }
});

test("follow-ups and the API carry the gates, and the API waives prerequisites", async () => {
  const { store, actions, make } = setup();
  try {
    const review = make({}, "observe");
    store.updateTask(review.id, { report: { summary: "", changedFiles: [], findings: [
      { title: "Create @crane/agent-policy", detail: "After the protocol package.", impact: "high", effort: "medium" },
    ] } });
    const protocol = make({ title: "Protocol" });
    const followUp = actions.followUp(review.id, 0, { prerequisites: [protocol.id], acceptance: ["It builds"] });
    assert.deepEqual(followUp.prerequisites, [protocol.id]);
    assert.deepEqual(followUp.acceptance, ["It builds"]);
    assert.throws(() => actions.followUp(review.id, 0, { prerequisites: ["t-nope"] }), /No task t-nope/);

    const app = createApp(store);
    const viaApi = await app.request(`/api/tasks/${review.id}/follow-up`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ finding: 0, prerequisites: [protocol.id], acceptance: ["It builds"] }),
    });
    assert.equal(viaApi.status, 201);
    const created = await viaApi.json();
    assert.deepEqual(created.prerequisites, [protocol.id]);

    const detail = await (await app.request(`/api/tasks/${created.id}`)).json();
    assert.deepEqual(detail.prerequisites, [{ id: protocol.id, title: "Protocol", status: "queued", met: false }]);

    const bad = await app.request(`/api/tasks/${created.id}/waive-prerequisites`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "[]",
    });
    assert.equal(bad.status, 400);
    assert.equal(store.getTask(created.id)!.prerequisitesWaivedAt, null, "a malformed body never waives");
    const ok = await app.request(`/api/tasks/${created.id}/waive-prerequisites`, { method: "POST" });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).prerequisitesWaivedAt);
  } finally { store.close(); }
});

test("factory: holds a task for its prerequisites, tells the agent where they stand, and sends unmet scope to review", async (t) => {
  const { store, make } = setup();
  const prerequisite = make({ title: "Shared setup" }, "observe");
  store.setStatus(prerequisite.id, "needs_review");
  const held = make({ title: "Builds on it", prerequisites: [prerequisite.id] }, "observe");
  const partial = make({ title: "Partial", acceptance: ["The package exists"] }, "observe");
  const seen: RunContext[] = [];
  const driver: AgentDriver = {
    name: "test", label: "Test", available: async () => true,
    run: async (ctx) => {
      seen.push(ctx);
      return { report: report(ctx.task.id === partial.id ? [{ criterion: "The package exists", met: false, evidence: "Not yet" }] : undefined) };
    },
  };
  const factory = new Factory(store, driver, { crewSize: 1, tickMs: 10 });
  t.after(async () => { await factory.stop(); store.close(); });
  factory.start();
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  await waitFor(() => store.getTask(partial.id)?.status !== "queued" && store.getTask(partial.id)?.status !== "running");
  assert.equal(store.getTask(partial.id)?.status, "needs_review", "no findings, but unmet acceptance is for the operator");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.getTask(held.id)?.status, "queued", "still held");
  assert.ok(!seen.some((ctx) => ctx.task.id === held.id));

  store.setStatus(prerequisite.id, "approved"); // Reviewed, no branch: landed.
  await waitFor(() => store.getTask(held.id)?.status === "done");
  assert.equal(store.getTask(held.id)?.status, "done");
  assert.deepEqual(seen.find((ctx) => ctx.task.id === held.id)?.prerequisites, [
    { id: prerequisite.id, title: "Shared setup", status: "approved", met: true },
  ]);
  assert.equal(seen.find((ctx) => ctx.task.id === partial.id)?.prerequisites, undefined);
});
