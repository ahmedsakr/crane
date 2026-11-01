import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReport } from "@crane/agent-protocol";

test("report: malformed or missing JSON preserves the plain-text summary", () => {
  for (const suffix of ["", "```crane-report\n{broken}\n```", "```crane-report\nnull\n```", "```crane-report\n{\"summary\":\"unfinished\"}"]) {
    assert.deepEqual(parseReport(`Work stopped before validation.\n\n${suffix}`), {
      summary: "Work stopped before validation.", findings: [], changedFiles: [],
    });
  }
  assert.deepEqual(parseReport(" \n\n "), {
    summary: "The agent finished without a summary.", findings: [], changedFiles: [],
  });
  assert.equal(parseReport("x".repeat(700)).summary, "x".repeat(600));
});

test("report: partial findings are normalized without losing valid evidence", () => {
  const raw = {
    summary: "  Fixed the regression.  ",
    findings: [null, false, 42, "junk", {}, { title: "Risk", detail: "Needs review", impact: "high", effort: "small" },
      { title: 12, detail: false, impact: "critical", effort: "tiny" }],
    changedFiles: ["src/core/store.ts", 42],
    validation: [{ status: "passed" }],
  };
  assert.deepEqual(parseReport(`Preamble.\n\n\`\`\`crane-report\n${JSON.stringify(raw)}\n\`\`\``), {
    summary: "Fixed the regression.",
    findings: [
      { title: "Untitled finding", detail: "", impact: "medium", effort: "medium" },
      { title: "Risk", detail: "Needs review", impact: "high", effort: "small" },
      { title: "12", detail: "false", impact: "medium", effort: "medium" },
    ],
    changedFiles: ["src/core/store.ts", "42"],
  });
});

test("report: code fences inside a finding's Markdown don't end the report early", () => {
  const raw = {
    summary: "Fixed the flaky test.",
    findings: [{ title: "Reproduce", detail: "Run:\n```sh\nnpm test\n```\nthen compare.", impact: "high", effort: "small" }],
    changedFiles: ["test/a.test.ts"],
  };
  for (const json of [JSON.stringify(raw), JSON.stringify(raw, null, 2)]) {
    assert.deepEqual(parseReport(`Done.\n\n\`\`\`crane-report\n${json}\n\`\`\`\n`), {
      summary: "Fixed the flaky test.",
      findings: [raw.findings[0]],
      changedFiles: ["test/a.test.ts"],
    });
  }
  // The prose fallback still sees the message without the block.
  const empty = JSON.stringify({ summary: "", findings: [{ title: "x", detail: "```\ncode\n```" }] });
  assert.equal(parseReport(`\`\`\`crane-report\n${empty}\n\`\`\`\n\nValidation is incomplete.`).summary, "Validation is incomplete.");
});

test("report: an empty structured summary uses prose outside the fence", () => {
  for (const summary of [undefined, "", "  "]) {
    const report = parseReport(`\`\`\`crane-report\n${JSON.stringify({ summary, findings: {}, changedFiles: "x.ts" })}\n\`\`\`\n\nValidation is incomplete.`);
    assert.deepEqual(report, { summary: "Validation is incomplete.", findings: [], changedFiles: [] });
  }
});
