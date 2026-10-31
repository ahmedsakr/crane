import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import { SimulatedDriver } from "../src/agents/simulated.js";
import { MAINTENANCE_ROLE, MAINTENANCE_ROLES } from "../src/core/types.js";

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

const finished = (store: Store, id: string) => ["done", "needs_review"].includes(store.getTask(id)!.status);

/** A store with a crew and Crane's own repo registered (pointing at this checkout, read-only work only). */
function setup() {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd(), name: "crane", isFactory: true });
  for (const name of ["Jib", "Boom"]) store.upsertAgent({ id: `a-${name.toLowerCase()}`, name, driver: "simulated" });
  return { store, actions, repo };
}

test("store: an assigned task is claimed only by its member, and a dedicated member claims only its own", () => {
  const { store, repo } = setup();
  const base = { kind: "maintenance" as const, brief: "", repoId: repo.id, autonomy: "observe" as const };
  const forBoom = store.createTask({ ...base, title: "For Boom", assignee: "a-boom" });
  const general = store.createTask({ ...base, title: "Anyone" });
  assert.equal(forBoom.assignee, "a-boom");
  assert.equal(general.assignee, null);

  assert.equal(store.claimNextTask("a-jib")?.id, general.id, "Jib skips Boom's older task");
  assert.equal(store.claimNextTask("a-jib"), null);

  const another = store.createTask({ ...base, title: "Anyone again" });
  assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true })?.id, forBoom.id);
  assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true }), null, "a dedicated member leaves general work alone");
  assert.equal(store.claimNextTask("a-boom")?.id, another.id, "a general member takes it");
  store.close();
});

test("crew: roles are checked, persist, and can be cleared", async () => {
  const { store, actions } = setup();
  await assert.rejects(actions.configureCrew("a-jib", { role: "astrology" }), /Unknown maintenance role/);
  await actions.configureCrew("a-jib", { role: "code-quality" });
  assert.equal(store.listAgents().find((a) => a.id === "a-jib")!.role, "code_quality", "dashes are accepted");
  await actions.configureCrew("a-jib", { active: false });
  assert.equal(store.listAgents().find((a) => a.id === "a-jib")!.role, "code_quality", "other settings leave the role alone");
  await actions.configureCrew("a-jib", { role: "none" });
  assert.equal(store.listAgents().find((a) => a.id === "a-jib")!.role, null);
  store.setSetting("crew_role_a-jib", "retired-role");
  assert.equal(store.listAgents().find((a) => a.id === "a-jib")!.role, null, "an unknown saved role reads as none");
  store.close();
});

test("actions: starting a member's run queues a maintenance task on Crane, for that member only", async () => {
  const { store, actions, repo } = setup();
  await assert.rejects(actions.runRole("a-nobody"), /No crew member/);
  await assert.rejects(actions.runRole("a-boom"), /Boom has no maintenance role/);

  await actions.configureCrew("a-boom", { role: "security", active: false });
  await assert.rejects(actions.runRole("a-boom"), /Boom is on-call/);
  await actions.configureCrew("a-boom", { active: true });

  const t = await actions.runRole("a-boom");
  assert.equal(t.kind, "maintenance");
  assert.equal(t.repoId, repo.id);
  assert.equal(t.assignee, "a-boom");
  assert.equal(t.autonomy, MAINTENANCE_ROLE.security.autonomy);
  assert.equal(t.title, "Review security in crane");
  assert.match(t.brief, /Review security/);
  assert.ok(store.listEvents(t.id).some((e) => e.type === "operator" && /Boom's security review run/.test(e.message)));

  await assert.rejects(actions.runRole("a-boom"), /already has a run under way/, "no double runs");
  assert.throws(
    () => actions.createTask({ kind: "maintenance", title: "X", brief: "", repoId: repo.id, autonomy: "observe", assignee: "a-ghost" }),
    /No crew member a-ghost/,
    "an assignee nobody can claim is refused",
  );
  actions.cancel(t.id);
  const retried = actions.retry(t.id);
  assert.equal(retried.assignee, "a-boom", "a retry goes back to the same member");
  store.close();
});

test("roles: every role has copy and a freedom level", () => {
  for (const r of MAINTENANCE_ROLES) {
    const role = MAINTENANCE_ROLE[r];
    assert.ok(role.label && role.action && role.summary && role.brief, r);
    assert.ok(["observe", "propose", "act"].includes(role.autonomy), r);
    assert.notEqual(role.autonomy, "act", `${r} should leave the operator a decision`);
  }
});

test("factory: a member with a role works only the runs started for it", async (t: TestContext) => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd(), name: "crane", isFactory: true });
  const factory = new Factory(store, new SimulatedDriver(1), { crewSize: 1, tickMs: 10 });
  t.after(async () => {
    await factory.stop({ graceMs: 200 });
    store.close();
  });
  factory.start();

  await actions.configureCrew("a-boom", { role: "security", active: true });
  await actions.configureCrew("a-jib", { active: false });
  const general = actions.createTask({ kind: "maintenance", title: "General", brief: "", repoId: repo.id, autonomy: "observe" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(store.getTask(general.id)!.status, "queued", "Boom leaves general work for the rest of the crew");

  const run = await actions.runRole("a-boom");
  await until(() => finished(store, run.id), "Boom's run to finish");
  assert.equal(store.getTask(run.id)!.agentId, "a-boom");
  assert.equal(store.getTask(general.id)!.status, "queued");

  await actions.configureCrew("a-jib", { active: true });
  await until(() => finished(store, general.id), "Jib to take the general task");
  assert.equal(store.getTask(general.id)!.agentId, "a-jib");
});
