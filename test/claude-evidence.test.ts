import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeToolResult, claudeValidationSummary } from "../packages/agent-drivers/src/claude-evidence.js";
import { CommandTracker } from "../packages/agent-drivers/src/command-evidence.js";
import type { CommandEvidence } from "@crane/contracts";
import { claudeResultShapes } from "./support/claude-results.js";

for (const fixture of claudeResultShapes) {
  test(`Claude result shape: ${fixture.name}`, () => {
    const events: CommandEvidence[] = [];
    const tracker = new CommandTracker(command => events.push(command));
    tracker.record("started", { id: "check" }, "npm test", null);
    const result = claudeToolResult(fixture.block, fixture.metadata);
    assert.equal(result.exitCode, fixture.exitCode);
    assert.equal(result.exitCodeSource, fixture.source);
    assert.equal(result.isError, fixture.block.is_error);
    let status = result.isError ? "failed" : "completed";
    if (result.interrupted) status = "interrupted";
    tracker.record("completed", {
      id: "check", exit_code: result.exitCode,
      status,
    }, "", null);
    tracker.close(false);
    assert.equal(events.at(-1)!.status, fixture.status);
    const summary = claudeValidationSummary([events.at(-1)!]);
    if (fixture.exitCode === null) {
      assert.match(summary, /no recorded process exit code/);
      assert.match(summary, /npm test/);
      assert.match(summary, /do not establish exit 0/);
    } else assert.equal(summary, "");
  });
}

test("Claude exit evidence rejects non-numeric and invalid codes without parsing output", () => {
  for (const exit_code of ["0", false, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = claudeToolResult({ is_error: false, content: "Exit code 0" }, { exit_code });
    assert.equal(result.exitCode, null);
    assert.equal(result.exitCodeSource, null);
  }
  for (const metadata of [undefined, null, "exitCode: 0", []]) {
    assert.equal(claudeToolResult({ is_error: false, content: "# fail 0" }, metadata).exitCode, null);
  }
});

test("Claude validation qualifications cover lost results and bound redacted command examples", () => {
  const outcomes = new Map<string, CommandEvidence>();
  const tracker = new CommandTracker(command => outcomes.set(command.commandId, command));
  tracker.record("started", { id: "done" }, "npm run typecheck", null);
  tracker.record("completed", { id: "done", exit_code: 0, status: "completed" }, "", null);
  for (let i = 0; i < 10; i++) tracker.record("started", { id: `lost-${i}` }, `npm test ${"x".repeat(300)} TOKEN=hide-me`, null);
  tracker.close(false);
  const summary = claudeValidationSummary([...outcomes.values()]);
  assert.match(summary, /10 Bash command/);
  assert.doesNotMatch(summary, /hide-me|npm run typecheck/);
  assert.ok(summary.length < 2000);
  assert.equal(claudeValidationSummary([]), "");
});

test("Claude evidence retains multiline probes and explicit diagnostic outcomes", () => {
  const events: CommandEvidence[] = [];
  const tracker = new CommandTracker((e) => events.push(e));
  const command = 'node -e "\nconsole.log(1);\nprocess.exit(2);\n"';
  tracker.record("started", { id: "probe" }, command, "session");
  const result = claudeToolResult({ is_error: true, content: "Exit code 2\nExpected regression failure" }, {
    exit_code: 2, stdout: "1\n", stderr: "Expected regression failure", interrupted: false,
  });
  tracker.record("completed", { id: "probe", exit_code: result.exitCode, status: "failed" }, "", "session");
  assert.equal(events[1]!.command, command);
  assert.equal(events[1]!.itemId, "probe");
  assert.equal(events[1]!.commandId, events[0]!.commandId);
  assert.equal(events[1]!.exitCode, 2);
  assert.equal(events[1]!.status, "failed");
  assert.equal(result.content.text, "Exit code 2\nExpected regression failure");
  assert.deepEqual(result.stdout, { text: "1\n", truncated: false });
  assert.equal(result.interrupted, false);
});

test("Claude results preserve absent metadata and exclude non-text payloads", () => {
  const result = claudeToolResult({ content: [
    { type: "text", text: "first" },
    { type: "image", source: { data: "sensitive-image" } },
    { type: "text", text: "last" },
  ] }, { exitCode: "0", arbitrary: "private" });
  assert.deepEqual(result, {
    isError: null, exitCode: null, exitCodeSource: null, content: { text: "first\nlast", truncated: false },
  });
  assert.equal(claudeToolResult({ is_error: false, content: "ok" }, { exitCode: 0 }).exitCode, 0);
  assert.equal(claudeToolResult({}, undefined).exitCode, null);
});

test("Claude interrupted results retain their reported outcome without inventing an exit code", () => {
  const events: CommandEvidence[] = [];
  const tracker = new CommandTracker((e) => events.push(e));
  const result = claudeToolResult({ is_error: true, content: "Command interrupted" }, { interrupted: true });
  tracker.record("started", { id: "stopped" }, "npm test", null);
  tracker.record("completed", { id: "stopped", status: "interrupted", exit_code: result.exitCode }, "", null);
  assert.equal(events[1]!.status, "interrupted");
  assert.equal(events[1]!.exitCode, null);
  tracker.close(false);
  assert.equal(events.length, 2);
});

test("Claude diagnostics redact before truncating and mark each bounded field", () => {
  const result = claudeToolResult({ is_error: true, content: `API_TOKEN="${"secret".repeat(2000)}"\n${"x".repeat(9000)}` }, {
    stdout: `Authorization: Bearer hide-me\n${"y".repeat(5000)}`,
    stderr: 'password="hide-me"',
  });
  assert.equal(result.content.text.length, 8192);
  assert.equal(result.content.truncated, true);
  assert.equal(result.stdout!.text.length, 4096);
  assert.equal(result.stdout!.truncated, true);
  assert.equal(result.stderr!.truncated, false);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("hide-me"));
});
