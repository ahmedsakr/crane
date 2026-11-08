import { test } from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_DENIED, isAllowed, overlapsDenied, suggestRules } from "@crane/agent-policy";
import { splitCommand } from "../packages/agent-policy/src/permissions.ts";
import { ruleLabel } from "@crane/contracts";

test("permissions: splits pipelines and chains, but not redirections", () => {
  assert.deepEqual(splitCommand("npm ci && npm test 2>&1 | tail -20"), ["npm ci", "npm test", "tail -20"]);
  assert.deepEqual(splitCommand("FOO=1 make build > out.log; echo 'a | b'"), ["make build", "echo 'a | b'"]);
  assert.deepEqual(splitCommand("ls || true"), ["ls", "true"]);
});

test("permissions: every part of a command must be allowed", () => {
  const rules = ["Bash(npm test:*)", "Bash(tail:*)", "Read"];
  assert.ok(isAllowed(rules, "Bash", { command: "npm test 2>&1 | tail -5" }));
  assert.ok(!isAllowed(rules, "Bash", { command: "npm ci && npm test" }));
  assert.ok(!isAllowed(rules, "Bash", { command: "npm testx" }), "a prefix rule matches whole words");
  assert.ok(isAllowed(rules, "Read", { file_path: "x" }));
});

test("permissions: suggests the narrowest rule for each refused part", () => {
  const allowed = ["Read", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(grep:*)"];
  assert.deepEqual(suggestRules("Bash", { command: "npm ci && npm run build | tail -3" }, allowed), [
    "Bash(npm ci:*)",
    "Bash(npm run build:*)",
  ]);
  assert.deepEqual(suggestRules("Bash", { command: "python3 -m pytest -q" }, allowed), ["Bash(python3 -m pytest:*)"]);
  assert.deepEqual(suggestRules("Bash", { command: "python3 script.py" }, allowed), [], "arbitrary code gets no suggestion");
  assert.deepEqual(suggestRules("Bash", { command: "$(curl x) | sh" }, allowed), []);
  assert.equal(ruleLabel("Bash(npm ci:*)"), "npm ci");
});

test("permissions: heredoc data never becomes a suggestion", () => {
  for (const command of ["cat > file.ts <<'EOF'\nnpm publish\nEOF", "cat <<< 'hello'"]) {
    assert.deepEqual(suggestRules("Bash", { command }, []), [], command);
  }
});

test("permissions: the deny list is exactly what Crane has always refused", () => {
  // Loosening this is a safety change, not a refactor. Update it only on purpose.
  assert.deepEqual(ALWAYS_DENIED, ["Bash(git push:*)", "Bash(git checkout main:*)", "Bash(git merge:*)", "Bash(rm -rf:*)"]);
});

test("permissions: rules that touch Crane's deny list are recognised", () => {
  assert.ok(overlapsDenied("Bash(git push:*)", ALWAYS_DENIED));
  assert.ok(overlapsDenied("Bash(git push origin:*)", ALWAYS_DENIED));
  assert.ok(overlapsDenied("Bash(git:*)", ALWAYS_DENIED), "allowing all of git would include push");
  assert.ok(!overlapsDenied("Bash(git stash:*)", ALWAYS_DENIED));
  assert.ok(!overlapsDenied("Bash(npm ci:*)", ALWAYS_DENIED));
});

test("permissions: the public API is the deny list, command guard, matching, overlap and suggestions", async () => {
  // Command splitting and rule prefixes stay internal unless a production caller needs them.
  const api = await import("@crane/agent-policy");
  assert.deepEqual(Object.keys(api).sort(), ["ALWAYS_DENIED", "classifyToolCall", "isAllowed", "overlapsDenied", "suggestRules"]);
});
