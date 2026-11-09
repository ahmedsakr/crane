import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_ACCESS, COMMAND_ACCESS_LABEL, isCommandAccess } from "@crane/contracts";
import type { AgentDriver, RunContext, RunResult } from "@crane/agent-protocol";
import { Store } from "../src/core/store.js";
import { worktreesDir } from "@crane/backend-runtime";
import { OperatorActions } from "../src/factory/actions.js";
import { runAgent } from "../src/factory/agent-runner.js";
import { createApp } from "../src/server/app.js";
import { temporaryRoot, testHome } from "./support/fixtures.ts";

function setup(path = "/code/app") {
  const store = new Store(":memory:");
  const repo = store.addRepo({ path, name: "app" });
  return { store, repo, actions: new OperatorActions(store) };
}

test("command access: three choices, each with a label", () => {
  assert.deepEqual(COMMAND_ACCESS, ["listed", "most", "auto"]);
  assert.deepEqual(COMMAND_ACCESS_LABEL, {
    listed: "Only allowed commands",
    most: "Most commands",
    auto: "Most commands, with auto mode",
  });
  for (const value of ["Listed", "toString", "", null, 1, undefined]) assert.equal(isCommandAccess(value), false, String(value));
});

test("command access: repos saved before the setting, or with a value Crane doesn't know, read as listed", () => {
  const { store, repo } = setup();
  try {
    assert.deepEqual(store.repoTools(repo.id), { allowed: [], keptBlocked: [], commands: "listed" });
    store.setSetting(`tools:${repo.id}`, JSON.stringify({ allowed: ["Bash(npm ci:*)"], keptBlocked: ["Bash(curl:*)"] }));
    assert.deepEqual(store.repoTools(repo.id), { allowed: ["Bash(npm ci:*)"], keptBlocked: ["Bash(curl:*)"], commands: "listed" });
    store.setSetting(`tools:${repo.id}`, JSON.stringify({ allowed: [], keptBlocked: [], commands: "everything" }));
    assert.equal(store.repoTools(repo.id).commands, "listed");
  } finally { store.close(); }
});

test("command access: the store round-trips it, and saving one part keeps the others", () => {
  const { store, repo } = setup();
  try {
    store.setRepoTools(repo.id, { allowed: ["Bash(npm ci:*)", "Bash(npm ci:*)"], keptBlocked: [], commands: "auto" });
    assert.deepEqual(store.repoTools(repo.id), { allowed: ["Bash(npm ci:*)"], keptBlocked: [], commands: "auto" });
    store.setRepoTools(repo.id, { allowed: [] });
    assert.deepEqual(store.repoTools(repo.id), { allowed: [], keptBlocked: [], commands: "auto" });
  } finally { store.close(); }
});

test("command access: changing it keeps allowed and kept-blocked commands, and command decisions keep it", () => {
  const { store, repo, actions } = setup();
  try {
    actions.allowTool(repo.id, "npm ci");
    actions.keepBlocked(repo.id, "curl");
    const lists = { allowed: ["Bash(npm ci:*)"], keptBlocked: ["Bash(curl:*)"] };
    assert.deepEqual(actions.setCommandAccess(repo.id, "most"), { ...lists, commands: "most" });
    assert.deepEqual(actions.setCommandAccess(repo.name, " AUTO "), { ...lists, commands: "auto" }, "by name, any case");
    assert.deepEqual(store.repoTools(repo.id), { ...lists, commands: "auto" });
    actions.allowTool(repo.id, "make lint");
    actions.keepBlocked(repo.id, "wget");
    actions.disallowTool(repo.id, "npm ci");
    assert.equal(store.repoTools(repo.id).commands, "auto", "allow, keep-blocked and disallow leave the setting alone");
    assert.deepEqual(actions.setCommandAccess(repo.id, "listed"), {
      allowed: ["Bash(make lint:*)"], keptBlocked: ["Bash(curl:*)", "Bash(wget:*)"], commands: "listed",
    });
  } finally { store.close(); }
});

test("command access: invalid values are refused with the choices, and change nothing", () => {
  const { store, repo, actions } = setup();
  try {
    actions.allowTool(repo.id, "npm ci");
    actions.setCommandAccess(repo.id, "most");
    const before = store.repoTools(repo.id);
    for (const value of ["everything", "", "  ", "toString"]) {
      assert.throws(() => actions.setCommandAccess(repo.id, value), /Unknown command access “.*”\. Use one of: listed, most, auto/, value);
    }
    for (const value of [undefined, null, 1, true, ["most"], { commands: "most" }]) {
      assert.throws(() => actions.setCommandAccess(repo.id, value), /Choose which commands agents may run: listed, most, auto/, String(value));
    }
    assert.throws(() => actions.setCommandAccess("r-missing", "auto"), /No repo r-missing/);
    assert.deepEqual(store.repoTools(repo.id), before);
  } finally { store.close(); }
});

test("command access: a change is noted on the task that prompted it", () => {
  const { store, repo, actions } = setup();
  try {
    const task = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: repo.id, autonomy: "propose" });
    actions.setCommandAccess(repo.id, "most", task.id);
    const note = store.listEvents(task.id).find((e) => e.type === "operator");
    assert.equal(note?.message, "Set commands for app to “Most commands”");
    assert.deepEqual(note?.data, { commands: "most", repoId: repo.id });
  } finally { store.close(); }
});

test("command access: PUT /repos/:id/tools/commands changes it, and the overview shows it", async () => {
  const { store, repo, actions } = setup();
  try {
    actions.allowTool(repo.id, "npm ci");
    const app = createApp(store);
    const put = (id: string, body: string) => app.request(`/api/repos/${id}/tools/commands`, {
      method: "PUT", headers: { "content-type": "application/json" }, body,
    });
    const overviewTools = async () =>
      ((await (await app.request("/api/overview")).json()) as { repos: { id: string; tools: unknown }[] })
        .repos.find((r) => r.id === repo.id)!.tools;
    assert.deepEqual(await overviewTools(), { allowed: ["Bash(npm ci:*)"], keptBlocked: [], commands: "listed" });

    const changed = await put(repo.id, JSON.stringify({ commands: "auto" }));
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { allowed: ["Bash(npm ci:*)"], keptBlocked: [], commands: "auto" });
    assert.deepEqual(await overviewTools(), { allowed: ["Bash(npm ci:*)"], keptBlocked: [], commands: "auto" });

    for (const body of ['{"commands":"everything"}', '{"commands":42}', "{}", "", "[]", '"auto"', "{"]) {
      const refused = await put(repo.id, body);
      assert.equal(refused.status, 400, body);
      assert.match(((await refused.json()) as { error: string }).error, /listed, most, auto|JSON/, body);
      assert.equal(store.repoTools(repo.id).commands, "auto", body);
    }
    assert.equal((await put("r-missing", JSON.stringify({ commands: "most" }))).status, 404);
    assert.equal((await put("app", JSON.stringify({ commands: "most" }))).status, 200, "by name, like the checks route");
    assert.equal(store.repoTools(repo.id).commands, "most");
  } finally { store.close(); }
});

/** Records what each run was given. */
class RecordingDriver implements AgentDriver {
  readonly name = "recording";
  readonly label = "Recording";
  calls: RunContext[] = [];
  async available() {
    return true;
  }
  async run(ctx: RunContext): Promise<RunResult> {
    this.calls.push(ctx);
    return { report: { summary: "ok", findings: [], changedFiles: [] } };
  }
}

test("command access: runAgent reads it and CRANE_HOME at the start of every run", async (t) => {
  testHome(t);
  const { store, repo, actions } = setup(temporaryRoot(t, "crane-command-checkout-"));
  try {
    store.upsertAgent({ id: "a-jib", name: "Jib", driver: "recording" });
    const task = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: repo.id, autonomy: "propose" });
    const driver = new RecordingDriver();
    const cwd = join(worktreesDir(), task.id);
    mkdirSync(cwd);
    const run = () => runAgent({ store, maxTurns: 0, retryDelayMs: 1 }, "a-jib", driver, {
      task: store.getTask(task.id)!, repo, cwd, signal: new AbortController().signal, emit: () => {},
    });
    await run();
    actions.setCommandAccess(repo.id, "auto");
    await run();
    assert.deepEqual(driver.calls.map((c) => c.commandAccess), ["listed", "auto"], "a change applies to the next run");
    assert.deepEqual(driver.calls.map((c) => c.craneHome), [process.env.CRANE_HOME, process.env.CRANE_HOME]);

    await runAgent({ store, maxTurns: 0, retryDelayMs: 1 }, "a-jib", driver, {
      task: store.getTask(task.id)!, repo: null, cwd: "/tmp", signal: new AbortController().signal, emit: () => {},
    });
    assert.equal(driver.calls[2]!.commandAccess, "listed", "a run without a repo has only Crane's defaults");
  } finally { store.close(); }
});
