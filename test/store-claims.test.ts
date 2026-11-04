import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { claimEligibility } from "../src/core/store/claims.js";

const ANYONE = "(assignee IS NULL OR assignee = ?)";

test("eligibility: post-mortem only takes any post-mortem and binds nothing", () => {
  assert.deepEqual(claimEligibility("a-one", ["a-one"], { onlyPostmortems: true }), { sql: "postmortem_of IS NOT NULL", params: [] });
  // It wins over onlyAssigned, which it has no binding for.
  assert.deepEqual(claimEligibility("a-one", ["a-one"], { onlyPostmortems: true, onlyAssigned: true }), { sql: "postmortem_of IS NOT NULL", params: [] });
});

test("eligibility: no named crew leaves only the assignee to decide", () => {
  assert.deepEqual(claimEligibility("a-one", []), { sql: ANYONE, params: ["a-one"] });
  assert.deepEqual(claimEligibility("a-one", [], { onlyAssigned: true }), { sql: "assignee = ?", params: ["a-one"] });
});

test("eligibility: a named member adds post-mortems to their own work", () => {
  assert.deepEqual(claimEligibility("a-one", ["a-one"]), { sql: `(postmortem_of IS NOT NULL OR ${ANYONE})`, params: ["a-one"] });
  assert.deepEqual(claimEligibility("a-one", ["a-one"], { onlyAssigned: true }), { sql: "(postmortem_of IS NOT NULL OR assignee = ?)", params: ["a-one"] });
});

test("eligibility: any other member can't take post-mortems", () => {
  assert.deepEqual(claimEligibility("a-two", ["a-one"]), { sql: `(postmortem_of IS NULL AND ${ANYONE})`, params: ["a-two"] });
  assert.deepEqual(claimEligibility("a-two", ["a-one"], { onlyAssigned: true }), { sql: "(postmortem_of IS NULL AND assignee = ?)", params: ["a-two"] });
});

/** One post-mortem, one unassigned task, and one assigned to each member, oldest first. */
function setup(crew: string[]) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "crane-claims-")), "crane.db"));
  const repo = store.addRepo({ path: "/repo" });
  for (const id of ["a-one", "a-two"]) store.upsertAgent({ id, name: id, driver: "simulated" });
  store.setPostmortemSettings({ driver: null, model: null, effort: null, crew });
  const task = (title: string, extra: { assignee?: string; postmortemOf?: string }) =>
    store.createTask({ kind: "maintenance", title, brief: "", repoId: repo.id, autonomy: "observe", ...extra }).id;
  const ids = {
    postmortem: task("post-mortem", { postmortemOf: "t-source" }),
    open: task("open", {}),
    one: task("for one", { assignee: "a-one" }),
    two: task("for two", { assignee: "a-two" }),
  };
  return { store, ids };
}

function claimAll(store: Store, agentId: string, opts: Parameters<Store["claimNextTask"]>[1] = {}) {
  const claimed: string[] = [];
  for (let task = store.claimNextTask(agentId, opts); task; task = store.claimNextTask(agentId, opts)) claimed.push(task.id);
  return claimed;
}

test("claims: post-mortem only takes post-mortems, and only for a named member", () => {
  const { store, ids } = setup(["a-one"]);
  try {
    assert.deepEqual(claimAll(store, "a-two", { onlyPostmortems: true }), []);
    assert.deepEqual(claimAll(store, "a-one", { onlyPostmortems: true }), [ids.postmortem]);
  } finally {
    store.close();
  }
});

test("claims: with no named crew, a member takes post-mortems, open work and their own", () => {
  const { store, ids } = setup([]);
  try {
    assert.deepEqual(claimAll(store, "a-one"), [ids.postmortem, ids.open, ids.one]);
    assert.equal(store.getTask(ids.two)?.status, "queued");
  } finally {
    store.close();
  }
});

test("claims: a named member takes post-mortems as well as open work and their own", () => {
  const { store, ids } = setup(["a-one"]);
  try {
    assert.deepEqual(claimAll(store, "a-one"), [ids.postmortem, ids.open, ids.one]);
  } finally {
    store.close();
  }
});

test("claims: another member skips the named crew's post-mortem", () => {
  const { store, ids } = setup(["a-one"]);
  try {
    assert.deepEqual(claimAll(store, "a-two"), [ids.open, ids.two]);
    assert.equal(store.getTask(ids.postmortem)?.status, "queued");
  } finally {
    store.close();
  }
});
