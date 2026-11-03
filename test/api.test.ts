import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { createApp } from "../src/server/app.js";
import { ALL_STATUSES, type TaskSummary } from "@crane/contracts";
import { driverEffortKey, driverModelKey } from "../src/factory/settings.js";

test("api: invalid task decision bodies leave tasks and history unchanged", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    for (const action of ["approve", "reject", "retry"]) {
      const task = store.createTask({ kind: "maintenance", title: action, brief: "", repoId: repo.id, autonomy: "propose" });
      store.updateTask(task.id, { status: "needs_review", branch: `crane/${task.id}` });
      const before = store.getTask(task.id);
      const events = store.listEvents(task.id);
      const tasks = store.listTasks();
      const bodies = ["{", '{"merge":false', "null", "[]", "true", "42", '"text"'];
      if (action === "approve") {
        bodies.push(...["false", 0, 1, null, [], {}].map(merge => JSON.stringify({ merge })));
      }
      if (action !== "retry") {
        bodies.push(...[42, false, null, [], {}].map(note => JSON.stringify({ note })));
      }
      for (const body of bodies) {
        const response = await app.request(`/api/tasks/${task.id}/${action}`, {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
        const context = `${action}: ${body}`;
        assert.equal(response.status, 400, context);
        assert.deepEqual(store.getTask(task.id), before, context);
        assert.deepEqual(store.listEvents(task.id), events, context);
        assert.deepEqual(store.listTasks(), tasks, context);
      }
    }
  } finally { store.close(); }
});

test("api: a new task needs a known autonomy and kind, and text for its title and brief", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    const good = { kind: "maintenance", title: "Look around", brief: "Look around", repoId: repo.id, autonomy: "observe" };
    const post = (body: unknown) => app.request("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const refused: [Record<string, unknown>, RegExp][] = [
      // Not read-only by the only test that matters, `autonomy === "observe"`, so this would get a writing agent.
      [{ autonomy: "Observe" }, /Unknown autonomy “Observe”. Use one of: observe, propose, act/],
      [{ autonomy: "toString" }, /Unknown autonomy/],
      [{ autonomy: undefined }, /Unknown autonomy/],
      [{ kind: "chore" }, /Unknown kind “chore”/],
      [{ title: undefined }, /Give the task a title/],
      [{ title: 42 }, /Give the task a title/],
      [{ brief: undefined }, /brief must be text/],
    ];
    for (const [change, message] of refused) {
      const response = await post({ ...good, ...change });
      assert.equal(response.status, 400, JSON.stringify(change));
      assert.match(((await response.json()) as { error: string }).error, message);
    }
    assert.deepEqual(store.listTasks(), [], "nothing was created");
    assert.equal((await post(good)).status, 201);
    assert.equal(store.listTasks()[0]?.autonomy, "observe");
  } finally { store.close(); }
});

test("api: approval keeps empty-body defaults and honors approve only", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    for (const body of [undefined, "{}", '{"merge":true}', '{"merge":false,"note":"Reviewed"}']) {
      const task = store.createTask({ kind: "maintenance", title: "Approve", brief: "", repoId: repo.id, autonomy: "propose" });
      store.updateTask(task.id, { status: "needs_review", branch: `crane/${task.id}`,
        visualReview: { status: "not_required", commit: "test", tree: "test", note: "No UI changes", decidedAt: null } });
      const response = await app.request(`/api/tasks/${task.id}/approve`, { method: "POST", body });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, body?.includes("false") ? "approved" : "merging");
      if (body?.includes("Reviewed")) {
        assert.ok(store.listEvents(task.id).some(e => e.type === "operator" && e.message === "Approved: Reviewed"));
      }
    }
    for (const action of ["reject", "retry"]) {
      const task = store.createTask({ kind: "maintenance", title: action, brief: "", repoId: repo.id, autonomy: "observe" });
      store.updateTask(task.id, { status: "needs_review" });
      const response = await app.request(`/api/tasks/${task.id}/${action}`, { method: "POST" });
      assert.equal(response.status, action === "retry" ? 201 : 200);
      assert.equal((await response.json()).status, action === "retry" ? "queued" : "rejected");
    }
  } finally { store.close(); }
});

test("api: cross-origin and rebound requests change nothing", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const task = store.createTask({ kind: "maintenance", title: "Approve", brief: "", repoId: repo.id, autonomy: "propose" });
    store.updateTask(task.id, { status: "needs_review", branch: `crane/${task.id}`,
      visualReview: { status: "not_required", commit: "test", tree: "test", note: "No UI changes", decidedAt: null } });
    const app = createApp(store);
    const snapshot = () => ({ task: store.getTask(task.id), events: store.listEvents(task.id), repos: store.listRepos(), tools: store.repoTools(repo.id) });
    const before = snapshot();
    const writes: [string, string][] = [
      [`/api/tasks/${task.id}/approve`, ""],
      [`/api/repos/${repo.id}/tools/allow`, JSON.stringify({ rule: "Bash(curl:*)" })],
      ["/api/repos", JSON.stringify({ path: "/elsewhere" })],
    ];
    // What a page on another site can send without a preflight: a text/plain POST.
    const forged: [string, Record<string, string>][] = [
      ["evil origin", { origin: "https://evil.example" }],
      ["other local port", { origin: "http://localhost:8080" }],
      ["opaque origin", { origin: "null" }],
      ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
      ["same-site fetch metadata", { "sec-fetch-site": "same-site" }],
    ];
    for (const [path, body] of writes) {
      for (const [label, headers] of forged) {
        const response = await app.request(`http://localhost${path}`, {
          method: "POST", headers: { "content-type": "text/plain", ...headers }, body,
        });
        assert.equal(response.status, 403, `${label}: ${path}`);
      }
      // DNS rebinding: the attacker's name resolves to us, so Origin and Host agree but Host isn't ours.
      const rebound = await app.request(`http://evil.example:4471${path}`, {
        method: "POST", headers: { "content-type": "text/plain", origin: "http://evil.example:4471" }, body,
      });
      assert.equal(rebound.status, 403, `rebound: ${path}`);
    }
    assert.equal((await app.request("http://evil.example:4471/api/overview")).status, 403, "rebound reads are refused too");
    assert.deepEqual(snapshot(), before);

    // The dashboard itself, the Vite proxy (which keeps the browser's Host), and non-browser clients still work.
    assert.equal((await app.request("http://127.0.0.1:4471/api/overview")).status, 200);
    const sameOrigin = await app.request(`http://localhost:5173/api/tasks/${task.id}/approve`, {
      method: "POST", headers: { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" }, body: '{"merge":false}',
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(store.getTask(task.id)?.status, "approved");
    const script = await app.request(`/api/repos/${repo.id}/tools/allow`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule: "Bash(make:*)" }),
    });
    assert.equal(script.status, 200);

    // Exposed on purpose (crane serve --host 0.0.0.0): other hosts may reach it, but forged origins still can't write.
    const exposed = createApp(store, { exposed: true });
    assert.equal((await exposed.request("http://192.168.1.20:4471/api/overview")).status, 200);
    const lan = await exposed.request(`http://192.168.1.20:4471/api/repos/${repo.id}/tools/keep-blocked`, {
      method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ rule: "Bash(curl:*)" }),
    });
    assert.equal(lan.status, 403);
  } finally { store.close(); }
});

test("api: invalid effort cannot partially save or clear the model", async () => {
  const store = new Store(":memory:");
  try {
    store.setSetting(driverModelKey("codex"), "gpt-saved");
    store.setSetting(driverEffortKey("codex"), "high");
    const app = createApp(store);
    for (const model of ["gpt-replacement", null, "default"]) {
      for (const effort of ["invalid", 42]) {
        const response = await app.request("/api/drivers/codex", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, effort }),
        });
        assert.equal(response.status, 400);
        assert.equal(store.getSetting(driverModelKey("codex")), "gpt-saved");
        assert.equal(store.getSetting(driverEffortKey("codex")), "high");
      }
    }
  } finally { store.close(); }
});

test("api: post-mortem defaults validate atomically, reset, and stay separate from agent settings", async () => {
  const store = new Store(":memory:");
  try {
    const app = createApp(store);
    const read = async () => (await app.request("/api/factory/postmortem")).json();
    const save = (body: unknown) => app.request("/api/factory/postmortem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.deepEqual(await read(), { driver: null, model: null, effort: null, crew: [] });
    const chosen = { driver: "claude-code", model: "sonnet", effort: "max", crew: [] };
    assert.equal((await save(chosen)).status, 200);
    assert.deepEqual(await read(), chosen);
    for (const body of [null, [], true, 42, "text", { driver: "unknown" }, { driver: 42 },
      { driver: "codex", model: "valid", effort: "max" }, { model: "--flag" }, { model: "x", effort: 42 },
      { driver: "simulated", effort: "low" }, { driver: null, effort: "low" },
      { crew: "a-jib" }, { crew: ["a-ghost"] }, { crew: null }, { model: "x", crew: [42] }]) {
      assert.equal((await save(body)).status, 400, JSON.stringify(body));
      assert.deepEqual(await read(), chosen, "a refused change saves nothing");
    }
    assert.equal(store.getSetting(driverModelKey("claude-code")), null);
    assert.equal(store.getSetting(driverEffortKey("claude-code")), null);
    assert.equal((await save({ model: " default ", effort: "HIGH" })).status, 200);
    assert.deepEqual(await read(), { driver: "claude-code", model: null, effort: "high", crew: [] });
    assert.equal((await save({ driver: "codex", effort: "minimal" })).status, 200);
    assert.deepEqual(await read(), { driver: "codex", model: null, effort: "minimal", crew: [] });
    assert.equal((await save({ effort: null })).status, 200);
    assert.deepEqual(await read(), { driver: "codex", model: null, effort: null, crew: [] });
    assert.equal((await save({ driver: "default" })).status, 200);
    assert.deepEqual(await read(), { driver: null, model: null, effort: null, crew: [] });
    assert.equal((await save({ driver: "simulated", model: null, effort: "default" })).status, 200);
    store.upsertAgent({ id: "a-hoist", name: "Hoist", driver: "simulated" });
    assert.equal((await save({ crew: ["a-hoist"] })).status, 200);
    assert.deepEqual((await read()).crew, ["a-hoist"]);
    const overview = await (await app.request("/api/overview")).json();
    assert.equal(overview.agents.find((a: { id: string }) => a.id === "a-hoist").runsPostmortems, true);
    assert.equal((await save({ crew: [] })).status, 200);
    assert.deepEqual((await read()).crew, []);
  } finally { store.close(); }
});

test("api: invalid check settings cannot replace the operator's merge gates", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/factory", isFactory: true });
    const other = store.addRepo({ path: "/other" });
    const app = createApp(store);
    const put = (id: string, body: unknown) => app.request(`/api/repos/${id}/checks`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    for (const body of [null, {}, "npm test", [""], ["  "], ["npm test", 42]]) {
      const response = await put(repo.id, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { error: "Expected an array of nonempty commands" });
      assert.deepEqual(store.repoChecks(repo.id), ["npm run typecheck", "npm test"]);
    }
    assert.equal((await put("r-missing", ["npm test"])).status, 404);
    for (const commands of [["npm run lint", "npm test"], []]) {
      const response = await put(repo.id, commands);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), commands);
      assert.deepEqual(await (await app.request(`/api/repos/${repo.id}/checks`)).json(), commands);
      assert.deepEqual(store.repoChecks(other.id), [], "settings stay scoped to the selected repo");
    }
    assert.equal((await app.request("/api/repos/r-missing/checks")).status, 404);
  } finally { store.close(); }
});

test("api: checks saved by repo name are the ones the factory runs", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/other", name: "other" });
    const app = createApp(store);
    const response = await app.request("/api/repos/other/checks", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify([" npm test "]),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), ["npm test"]);
    assert.deepEqual(store.repoChecks(repo.id), ["npm test"]);
    assert.deepEqual(await (await app.request("/api/repos/other/checks")).json(), ["npm test"]);
  } finally { store.close(); }
});

test("api: polled task lists send summaries, and task detail keeps full briefs and reports", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    const logs = "a long test log\n".repeat(1000);
    const brief = "post-mortem history\n".repeat(10000);
    const report = {
      summary: "Did it", changedFiles: ["a.ts", "b.ts"],
      findings: [{ title: "One thing", detail: logs, impact: "low" as const, effort: "small" as const }],
      validation: [{ phase: "review" as const, commit: "abc", command: "npm test", status: "passed" as const, exitCode: 0, logs, durationMs: 1 }],
    };
    const ids = (["needs_review", "running", "merged"] as const).map((status) => {
      const task = store.createTask({ kind: "maintenance", title: status, brief, repoId: repo.id, autonomy: "propose" });
      store.updateTask(task.id, { status, report });
      return task.id;
    });

    const lists: Record<string, TaskSummary[]> = {
      tasks: await (await app.request("/api/tasks")).json(),
    };
    const overview = await (await app.request("/api/overview")).json();
    Object.assign(lists, { needsReview: overview.needsReview, inFlight: overview.inFlight, recent: overview.recent });
    for (const [name, list] of Object.entries(lists)) {
      assert.ok(list.length, name);
      for (const task of list) {
        assert.equal("brief" in task, false, `${name} leaves out briefs`);
        assert.equal("report" in task, false, `${name} leaves out full reports`);
        assert.equal(task.reportSummary, "Did it", `${name} keeps what the rows show`);
        assert.equal(task.changedFileCount, 2, name);
        assert.equal(task.findingCount, 1, name);
      }
      assert.ok(JSON.stringify(list).length < 2000, `${name} stays small with large briefs and reports`);
    }

    const detail = await (await app.request(`/api/tasks/${ids[0]}`)).json();
    assert.equal(detail.task.report.validation[0].logs, logs);
    assert.equal(detail.task.brief, brief);
    assert.deepEqual(detail.task.report, report);
    assert.deepEqual(store.listTasks().find(t => t.id === ids[0])?.report, report, "CLI lists retain full reports");
    assert.equal(store.getTask(ids[0]!)?.report?.validation?.[0]?.logs, logs, "nothing is removed from storage");
  } finally { store.close(); }
});

test("api: premature approval is rejected without changing the task or its history", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const task = store.createTask({ kind: "maintenance", title: "Fix", brief: "", repoId: repo.id, autonomy: "propose" });
    const app = createApp(store);
    const events = store.listEvents(task.id);
    const response = await app.request(`/api/tasks/${task.id}/approve`, { method: "POST" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /isn't waiting for review/);
    assert.deepEqual(store.getTask(task.id), task);
    assert.deepEqual(store.listEvents(task.id), events);
    assert.equal((await app.request("/api/tasks/t-missing")).status, 404);
  } finally { store.close(); }
});

test("api: task actions reject invalid states without changing tasks or history", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    for (const action of ["approve", "reject", "cancel", "merge"]) {
      const allowed = action === "cancel" ? ["queued", "running"]
        : action === "merge" ? ["needs_review", "approved", "done"] : ["needs_review"];
      for (const status of ALL_STATUSES.filter(status => !allowed.includes(status))) {
        const task = store.createTask({ kind: "maintenance", title: `${action} ${status}`, brief: "", repoId: repo.id, autonomy: "propose" });
        // A branch makes merge exercise its state guard rather than its no-code guard.
        store.updateTask(task.id, { status, branch: `crane/${task.id}` });
        const before = store.getTask(task.id);
        const events = store.listEvents(task.id);
        const response = await app.request(`/api/tasks/${task.id}/${action}`, { method: "POST" });
        const context = `${action} from ${status}`;
        assert.equal(response.status, 400, context);
        assert.match((await response.json()).error, /isn't (waiting for review|in progress|ready to merge)/, context);
        assert.deepEqual(store.getTask(task.id), before, context);
        assert.deepEqual(store.listEvents(task.id), events, context);
      }
    }
  } finally { store.close(); }
});

test("api: cancellation records the decision once and cannot cancel a finished task", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    for (const status of ["queued", "running"] as const) {
      const task = store.createTask({ kind: "maintenance", title: status, brief: "", repoId: repo.id, autonomy: "observe" });
      store.updateTask(task.id, { status });
      const response = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "cancelled");
      const cancelled = store.getTask(task.id)!;
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.finishedAt);
      const events = store.listEvents(task.id);
      assert.equal(events.filter(e => e.type === "operator" && e.message === "Cancelled by operator").length, 1);
      assert.equal((await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" })).status, 400);
      assert.deepEqual(store.getTask(task.id), cancelled);
      assert.deepEqual(store.listEvents(task.id), events);
    }
  } finally { store.close(); }
});
