import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actorLabel, describeClient, errorMessage, normalizeUsername, runCostLabel, runTokens,
  visualReviewPending, visualReviewWaivedByPreApproval, type EventActor, type RunUsage, type VisualReview,
} from "@crane/contracts";

const HOST: EventActor = { kind: "host", name: "ahmed" };

test("access: contract helpers describe clients and actors", () => {
  const cases: [string | null, string | null][] = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:120.0) Gecko/20100101 Firefox/120.0", "Firefox on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", "Chrome on Linux"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1", "Safari on iOS"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36", "Chrome on Android"],
    ["curl/8.4.0", "curl"],
    ["something else", null],
    ["", null],
    [null, null],
  ];
  for (const [ua, label] of cases) assert.equal(describeClient(ua), label, String(ua));
  assert.equal(actorLabel({ kind: "operator", id: "o-1", name: "Sam" }), "Sam");
  assert.equal(actorLabel(HOST), "ahmed on the host");
  assert.equal(normalizeUsername("  Sam.Lee "), "sam.lee");
});

const usage: RunUsage = {
  costUsd: 2, inputTokens: 3, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 11, turns: 1, model: "first",
};

test("errorMessage handles Errors and arbitrary thrown values", () => {
  assert.equal(errorMessage(new TypeError("bad input")), "bad input");
  for (const value of ["failure", null, undefined, 42, { message: "plain object" }]) {
    assert.equal(errorMessage(value), String(value));
  }
});

test("runCostLabel preserves reported, estimated, unknown and zero labels", () => {
  const format = (cost: number) => `$${cost.toFixed(2)}`;
  for (const [costStatus, costUsd, expected] of [
    [undefined, 2, "$2.00"], ["reported", 0, "$0.00"], ["estimated", 2, "~$2.00"],
    ["estimated", 0, "~$0.00"], ["unknown", 2, "$2.00 + unknown"], ["unknown", 0, "Unknown"],
  ] as const) {
    assert.equal(runCostLabel({ costStatus, costUsd }, format), expected);
  }
});

test("runTokens includes uncached input, both cache counts and output", () => {
  assert.equal(runTokens(usage), 26);
  assert.equal(runTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0);
});

test("pre-approval waives missing or pending visual decisions without hiding recorded decisions", () => {
  for (const status of [null, "pending", "not_required", "inspected", "waived"] as const) {
    const visualReview: VisualReview | null = status && {
      status, commit: "candidate", tree: "tree", note: "", decidedAt: null,
    };
    for (const preApprovedAt of [null, "2026-01-01"]) {
      const task = { branch: "task", visualReview, preApprovedAt };
      const undecided = status === null || status === "pending";
      assert.equal(visualReviewWaivedByPreApproval(task), !!preApprovedAt && undecided);
      assert.equal(visualReviewPending(task), !preApprovedAt && undecided);
      assert.equal(visualReviewPending({ ...task, branch: null }), false);
    }
  }
});
