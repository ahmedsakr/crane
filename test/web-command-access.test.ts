import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { COMMAND_ACCESS_LABEL, type BlockedTool, type TaskEvent } from "@crane/contracts";
import { accessChip, GUARD_ALWAYS_BLOCKS, GUARD_ASKS_FIRST } from "../web/src/lib/command-access.ts";
import { hardGuardRefusals, refusalLine } from "../web/src/lib/refusals.ts";

// tsx applies the root tsconfig only inside `src`, so web's .tsx files compile to React.createElement here.
Object.assign(globalThis, { React });
// Keep NodeNext from traversing web's extensionless imports.
const { AccessChoices, GuardDetails } = await import(new URL("../web/src/pages/repos/CommandsSheet.tsx", import.meta.url).href) as Record<string, ComponentType<never>>;
const { BlockedItem, GuardBlockedItem } = await import(new URL("../web/src/components/BlockedItem.tsx", import.meta.url).href) as Record<string, ComponentType<never>>;
const { BlockedSection } = await import(new URL("../web/src/pages/task/BlockedSection.tsx", import.meta.url).href) as Record<string, ComponentType<never>>;

const render = (component: ComponentType<never>, props: object) =>
  renderToStaticMarkup(h(MemoryRouter, null, h(component, props as never)));

const HARD = { source: "crane.guard", reason: "Changing shared Git state is Crane's job and requires the operator's approval." } as const;
const PUBLISH = { source: "crane.guard", reason: "Publishing or changing remote resources requires an operator rule for this repository." } as const;
const AUTO = { source: "claude.auto-mode", reason: "Resetting the shared database goes beyond what the task asked for." } as const;

function blockedEvent(id: number, command: string, data: Record<string, unknown>): TaskEvent {
  return { id, taskId: "t-1", ts: `2026-11-08T10:0${id}:00.000Z`, type: "blocked", message: `Blocked: ${command}`, data: { tool: "Bash", command, ...data } };
}

const tool: BlockedTool = {
  repoId: "r-1", repoName: "payments-api", rule: "Bash(npm publish:*)", label: "npm publish",
  tasks: 1, times: 1, lastAt: "2026-11-08T10:00:00.000Z", lastTaskId: "t-1",
};

test("commands sheet: three choices, in order, with the current one checked and a line on each", () => {
  const html = render(AccessChoices!, { value: "most", onChange: () => {} });
  const labels = [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Only allowed commands", "Most commands", "Most commands, with auto mode"]);
  assert.deepEqual(labels, Object.values(COMMAND_ACCESS_LABEL), "the same names as crane commands");
  assert.equal(html.match(/type="radio"/g)?.length, 3);
  assert.match(html, /checked="" value="most"/);
  assert.doesNotMatch(html, /checked="" value="(listed|auto)"/);
  assert.match(html, /What Crane allows, plus what you&#x27;ve allowed\./);
  assert.match(html, /Crane&#x27;s guard blocks risky ones\./);
  assert.match(html, /auto mode also reviews each command Crane&#x27;s guard lets through/);
});

test("commands sheet: what the guard blocks and what auto mode costs wait behind a disclosure", () => {
  const html = render(GuardDetails!, {});
  assert.match(html, /^<details class="access-details"><summary>What Crane&#x27;s guard blocks<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/, "closed until asked for");
  for (const label of [...Object.values(GUARD_ALWAYS_BLOCKS), ...Object.values(GUARD_ASKS_FIRST)]) {
    assert.ok(html.includes(label.replaceAll("'", "&#x27;")), label);
  }
  assert.match(html, /uses more tokens and adds a short wait per command/);
  assert.match(html, /fall back to only allowed commands when it&#x27;s unavailable/);
});

test("repo rows: only the wider settings show a chip", () => {
  assert.equal(accessChip("listed"), null);
  assert.equal(accessChip("most"), "Most commands");
  assert.equal(accessChip("auto"), "Auto mode");
});

test("refusals: guard and auto mode say why; allowlist refusals say nothing", () => {
  assert.equal(refusalLine(HARD), "Crane's guard blocked this: changing shared Git state is Crane's job and requires the operator's approval.");
  assert.equal(refusalLine(AUTO), "Auto mode blocked this: resetting the shared database goes beyond what the task asked for.");
  assert.equal(refusalLine({ source: "crane.guard", reason: "Crane's guard couldn't check this call" }), "Crane's guard blocked this: Crane's guard couldn't check this call");
  assert.equal(refusalLine({ source: "claude.auto-mode", reason: null }), "Auto mode blocked this.");
  assert.equal(refusalLine({ source: "claude-code.tool_result", reason: "This command requires approval" }), null);
  assert.equal(refusalLine(undefined), null);
});

test("refusals: hard guard refusals group by command, latest first, and skip anything the operator can allow", () => {
  const events = [
    blockedEvent(1, "git branch -f main HEAD", { refusal: HARD, guard: { category: "shared-git", overridable: false }, rules: [] }),
    blockedEvent(2, "npm publish", { refusal: PUBLISH, guard: { category: "publish", overridable: true }, rules: ["Bash(npm publish:*)"] }),
    blockedEvent(3, "npm run db:reset", { refusal: AUTO, rules: ["Bash(npm run db:reset:*)"] }),
    blockedEvent(4, "crane approve t-2", { refusal: { source: "crane.guard", reason: "Changing Crane's state is reserved for the operator." }, guard: { category: "operator-actions", overridable: false }, rules: [] }),
    blockedEvent(5, "git branch -f main HEAD", { refusal: HARD, guard: { category: "shared-git", overridable: false }, rules: [] }),
    blockedEvent(6, "docker compose up", { rules: ["Bash(docker compose:*)"] }),
    { ...blockedEvent(7, "ignored", {}), type: "note" },
  ] satisfies TaskEvent[];
  assert.deepEqual(hardGuardRefusals(events), [
    { what: "git branch -f main HEAD", reason: HARD.reason, times: 2, lastAt: events[4]!.ts },
    { what: "crane approve t-2", reason: "Changing Crane's state is reserved for the operator.", times: 1, lastAt: events[3]!.ts },
  ]);
});

test("blocked commands: overridable guard and auto-mode refusals keep Allow and Keep blocked, with their reason", () => {
  for (const [refusal, line] of [[PUBLISH, /Crane&#x27;s guard blocked this: publishing or changing remote resources/], [AUTO, /Auto mode blocked this: resetting the shared database/]] as const) {
    const html = render(BlockedItem!, { b: { ...tool, refusal }, onDone: () => {} });
    assert.match(html, line);
    assert.match(html, />Allow<\/button>/);
    assert.match(html, />Keep blocked<\/button>/);
  }
  assert.doesNotMatch(render(BlockedItem!, { b: tool, onDone: () => {} }), /blocked-reason/, "an allowlist refusal has no reason line");
});

test("blocked commands: a hard guard refusal reads as decided, with its reason and no actions", () => {
  const html = render(GuardBlockedItem!, { r: { what: "git branch -f main HEAD", reason: HARD.reason, times: 2, lastAt: tool.lastAt } });
  assert.match(html, /git branch -f main HEAD<\/code> stays blocked/);
  assert.match(html, /Crane&#x27;s guard blocked this: changing shared Git state is Crane&#x27;s job/);
  assert.match(html, /Can&#x27;t be allowed · Blocked 2 times · /);
  assert.doesNotMatch(html, /<button/);
});

test("task page: the blocked section lists decisions first, then hard guard refusals, and counts both", () => {
  const events = [blockedEvent(1, "git branch -f main HEAD", { refusal: HARD, guard: { category: "shared-git", overridable: false }, rules: [] })];
  const props = { blocked: [{ ...tool, refusal: PUBLISH }], events, taskId: "t-1", repoName: "payments-api", onDone: () => {} };
  const html = render(BlockedSection!, props);
  assert.match(html, /<span class="count">2<\/span>/);
  assert.ok(html.indexOf(">Allow</button>") < html.indexOf("stays blocked"), "the decision comes first");
  assert.match(html, /Allowing applies to every agent in payments-api/);
  const hardOnly = render(BlockedSection!, { ...props, blocked: [] });
  assert.match(hardOnly, /<span class="count">1<\/span>/);
  assert.doesNotMatch(hardOnly, /Allowing applies|<button/, "nothing to decide, so nothing to allow");
  assert.equal(render(BlockedSection!, { ...props, blocked: [], events: [] }), "");
});
