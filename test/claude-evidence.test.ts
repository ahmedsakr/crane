import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeToolResult } from "../src/agents/claude-evidence.js";
import { CommandTracker } from "../src/core/command-evidence.js";
import type { CommandEvidence } from "@crane/contracts";

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
    isError: null, exitCode: null, content: { text: "first\nlast", truncated: false },
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
