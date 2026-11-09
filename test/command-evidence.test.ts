import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEvidence } from "@crane/contracts";
import { CommandTracker, safeCommand } from "../packages/agent-drivers/src/command-evidence.js";
import { Store } from "@crane/storage";
import { resumePrompt, systemPrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";

test("conflict prompts separate checkpointed edits from resolver validation", () => {
  const store = new Store(":memory:");
  try {
    const task = store.createTask({ kind: "maintenance", title: "Resolution", brief: "", repoId: null, autonomy: "propose" });
    const job = { kind: "resolve_conflicts" as const, base: "main", files: ["notes.md"] };
    const editing = systemPrompt(task, null, { ...job, phase: "edit" });
    assert.match(editing, /before running builds, typechecks, tests, or screenshots/);
    assert.doesNotMatch(editing, /If the project has quick checks/);
    const validationJob = { ...job, phase: "validate" as const, checkpoint: "saved-sha" };
    const validation = systemPrompt(task, null, validationJob);
    assert.match(validation, /checkpoint saved-sha/);
    assert.match(validation, /there is no MERGE_HEAD/);
    assert.match(validation, /git diff HEAD\^2 HEAD/);
    assert.match(validation, /Run relevant checks/);
    assert.match(userPrompt(task, validationJob), /Validate resolution checkpoint `saved-sha`/);
  } finally {
    store.close();
  }
});

test("command evidence correlates completions, distinguishes failures and bounds retention", () => {
  const events: CommandEvidence[] = [];
  const tracker = new CommandTracker((e) => events.push(e));
  const long = `npm run screenshot -- /tasks ${"--wait-for '.detail-title' ".repeat(10)}--size 390x844`;
  tracker.record("started", { id: "i1" }, long, "session");
  tracker.record("completed", { id: "i1", exit_code: 0, status: "completed", aggregated_output: "private output" }, "", "session");
  assert.equal(events[0]!.commandId, events[1]!.commandId);
  assert.equal(events[1]!.command, long);
  assert.equal(events[1]!.status, "completed");
  assert.equal(events[1]!.exitCode, 0);
  assert.ok(!JSON.stringify(events).includes("private output"));
  tracker.record("completed", { id: "i2", exit_code: 2, status: "completed" }, "npm test", "session");
  assert.equal(events.at(-1)!.status, "failed");
  tracker.record("completed", { id: "i3", status: "completed" }, "npm test", "session");
  assert.equal(events.at(-1)!.status, "unknown");
  assert.equal(events.at(-1)!.exitCode, null);
  const other = new CommandTracker((e) => events.push(e));
  other.record("started", { id: "i1" }, "x".repeat(9000), "session");
  assert.notEqual(events.at(-1)!.commandId, events[0]!.commandId);
  assert.equal(events.at(-1)!.command.length, 8192);
  assert.equal(events.at(-1)!.truncated, true);
  other.close(true);
  assert.equal(events.at(-1)!.status, "interrupted");
  tracker.close(false);
  assert.equal(events.length, 6, "completed commands are not marked unknown on close");
});

test("command evidence redacts credentials before persisting or truncating", () => {
  const inputs = [
    "API_TOKEN=hide-me npm test",
    'curl --password "hide-me with spaces" https://example.test',
    'curl --password "prefix"hide-me https://example.test',
    'curl --password prefix\\ hide-me https://example.test',
    "curl -H 'Authorization: Bearer hide-me' https://example.test",
    "Authorization: Basic hide-me",
    "curl -H 'Cookie: session=hide-me' https://example.test",
    "curl https://user:hide-me@example.test/path?key=another-secret",
    "curl -u user:hide-me example.test",
    'node -e \'const x = {"api_key": "hide-me"}\'',
    `TOKEN="${"hide-me".repeat(2000)}" npm test`,
    "echo '-----BEGIN RSA PRIVATE KEY-----\nhide-me\n-----END RSA PRIVATE KEY-----'",
  ];
  for (const input of inputs) {
    const redacted = safeCommand(input).command;
    assert.ok(!redacted.includes("hide-me"), redacted);
    assert.ok(!redacted.includes("another-secret"), redacted);
    assert.ok(redacted.includes("[REDACTED"), redacted);
  }
  assert.equal(safeCommand("npm run screenshot -- /tasks --size 390x844").command,
    "npm run screenshot -- /tasks --size 390x844");
});

test("command evidence survives reopening, recovers missing completions and reaches resume/fallback prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "crane-command-evidence-"));
  const path = join(root, "crane.db");
  let store = new Store(path);
  try {
    const task = store.createTask({ kind: "maintenance", title: "Recovery", brief: "", repoId: null, autonomy: "observe" });
    const tracker = new CommandTracker((command) => store.addEvent(task.id, "tool", "command", { tool: "shell", command }));
    tracker.record("started", { id: "done" }, "npm run typecheck", "session");
    tracker.record("completed", { id: "done", status: "completed", exit_code: 0 }, "npm run typecheck", "session");
    tracker.record("started", { id: "lost" }, "npm test", "session");
    store.close();
    store = new Store(path);
    store.closeUnresolvedCommands();
    const recoveredCount = store.listEvents(task.id).length;
    store.closeUnresolvedCommands();
    let evidence = store.commandEvidence(task.id);
    assert.deepEqual(evidence.map((c) => [c.status, c.exitCode]), [["completed", 0], ["unknown", null]]);
    assert.equal(store.listEvents(task.id).length, recoveredCount, "recovery is idempotent");
    // A completion arriving during graceful shutdown supersedes an unknown outcome.
    tracker.record("completed", { id: "lost", status: "completed", exit_code: 1 }, "npm test", "session");
    evidence = store.commandEvidence(task.id);
    assert.equal(evidence[1]!.status, "failed");
    for (const prompt of [resumePrompt({ commandEvidence: evidence }), userPrompt(task, undefined, { commandEvidence: evidence })]) {
      assert.match(prompt, /npm run typecheck/);
      assert.match(prompt, /"exitCode":0/);
      assert.match(prompt, /not Crane's external review or merge checks/);
    }
    for (let i = 0; i < 45; i++) tracker.record("started", { id: `more-${i}` }, "x".repeat(8192), "session");
    store.closeUnresolvedCommands(task.id);
    evidence = store.commandEvidence(task.id);
    assert.equal(evidence.length, 40);
    assert.equal(evidence[0]!.itemId, "more-5");
    assert.ok(resumePrompt({ commandEvidence: evidence }).length < 40000);
    assert.ok(evidence.every((c) => c.status === "unknown"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
