import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { goalProgress, parseDiff, type DiffFile, type Goal, type GoalPlan, type GoalTask, type Task, type TaskStatus } from "@crane/contracts";
import { axisTick, emptyRangeHint, labelsDay, niceCeil, parseRange, perShippedTask, rangeParams, spendComparison, tipPosition, tokensIn, unknownCostNote } from "../web/src/lib/analytics.ts";
import { filePathLabel, fileStatusLabel, gutterWidth, inlineLineText, noLinesNote, openFileIndex, saveDiffLayout, savedDiffLayout } from "../web/src/lib/diff-view.ts";
import { addTask, canAddTask, goalListGroups, isCancellable, isPlanEditable, listProgress, patchTask, plannedText, removeTask, splitLines, taskForKey, withDependency, withoutBlankLines } from "../web/src/lib/goal-plan.ts";
import { newTaskInstruction, openTasksNote, parseCheckCommands } from "../web/src/lib/repos.ts";
import { dashboardNotice, factoryPill, instructFromSearch, isInstructShortcut } from "../web/src/lib/shell.ts";
import { siteTasks, zoneCounts, zoneSummary } from "../web/src/lib/site/summary.ts";

// tsx applies the root tsconfig only inside `src`, so web's .tsx files compile to React.createElement here.
Object.assign(globalThis, { React });
// By computed path: these import web modules without extensions, which only web's own tsconfig accepts.
const webModule = <Name extends string>(path: string): Promise<Record<Name, ComponentType<never>>> =>
  import(new URL(`../web/src/${path}`, import.meta.url).href);
const { FileDiff } = await webModule<"FileDiff">("components/diff/FileDiff.tsx");
const { ChangedFiles } = await webModule<"ChangedFiles">("components/diff/ChangedFiles.tsx");
const { DailyChart } = await webModule<"DailyChart">("pages/analytics/DailyChart.tsx");
const { GoalDecision } = await webModule<"GoalDecision">("pages/goals/GoalDecision.tsx");
const { PlanEditor } = await webModule<"PlanEditor">("pages/goals/PlanEditor.tsx");
const { GoalView } = await webModule<"GoalView">("pages/GoalPage.tsx");

const render = (component: ComponentType<never>, props: object) =>
  renderToStaticMarkup(h(MemoryRouter, null, h(component, props as never)));

const task = (key: string, change: Partial<GoalTask> = {}): GoalTask => ({
  key, title: `Task ${key}`, brief: "Do it", dependsOn: [], driver: "codex", model: null, effort: null, rationale: "Why", acceptance: ["Done"], ...change,
});
const plan = (tasks: GoalTask[]): GoalPlan => ({ summary: "Summary", approach: "Approach", improvements: [], tasks });
const goal = (change: Partial<Goal> = {}): Goal => ({
  id: "g-1", repoId: "r", title: "Save carts", outcome: "Carts persist", status: "needs_review", revision: 1, plan: plan([task("a"), task("b")]),
  feedback: [], tasks: [], approvedAt: null, autoMerge: false, error: null, ...change,
} as Goal);

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
].join("\n");

const diffFile = (change: Partial<DiffFile> = {}): DiffFile => ({ ...parseDiff(DIFF).files[0]!, ...change });

test("analytics: an unknown days param falls back to the default range, which keeps a clean URL", () => {
  assert.equal(parseRange("7"), 7);
  assert.equal(parseRange("90"), 90);
  assert.equal(parseRange("31"), 30);
  assert.equal(parseRange(null), 30);
  assert.deepEqual(rangeParams(30), {});
  assert.deepEqual(rangeParams(7), { days: "7" });
});

test("analytics: the axis tops out at a round amount at or above the tallest day", () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(1.1), 1.2);
  assert.equal(niceCeil(7), 8);
  assert.equal(niceCeil(80), 80);
  assert.equal(axisTick(0.5), "$0.5");
  assert.equal(axisTick(0.123), "$0.12");
});

test("analytics: the tip sits right of early columns and left of late ones", () => {
  assert.deepEqual(tipPosition(0, 4, 50), { bottom: "clamp(0px, calc(50% - 22px), calc(100% - 46px))", left: "calc(25% + 6px)" });
  assert.deepEqual(tipPosition(3, 4, 50), { bottom: "clamp(0px, calc(50% - 22px), calc(100% - 46px))", right: "calc(25% + 6px)" });
});

test("analytics: date labels count back from the latest day", () => {
  const labelled = Array.from({ length: 30 }, (_, i) => i).filter((i) => labelsDay(i, 30));
  assert.deepEqual(labelled, [4, 9, 14, 19, 24, 29]);
  assert.ok(labelsDay(6, 7), "a short range still labels its last day");
});

test("analytics: spend compares with the period before, unless nothing was spent then", () => {
  assert.equal(spendComparison({ spendUsd: 5, prevSpendUsd: 0 }, 30), "nothing in the 30 days before");
  assert.match(spendComparison({ spendUsd: 5, prevSpendUsd: 3 }, 7), /^\+\$2.* vs the 7 days before$/);
  assert.match(spendComparison({ spendUsd: 3, prevSpendUsd: 5 }, 7), /^−\$2.* vs the 7 days before$/);
  assert.match(spendComparison({ spendUsd: 3, prevSpendUsd: 3 }, 7), /^\+\$0/);
});

test("analytics: small figures and notes", () => {
  assert.equal(perShippedTask({ usd: 0, tasks: 0 } as never), "—");
  assert.match(perShippedTask({ usd: 9, tasks: 3 } as never), /^\$3/);
  assert.equal(tokensIn({ input: 1, cacheRead: 2, cacheWrite: 3, output: 100 } as never), 6);
  assert.equal(emptyRangeHint(30), ". Try a longer range.");
  assert.equal(emptyRangeHint(90), ".");
  assert.equal(unknownCostNote(0), "");
  assert.match(unknownCostNote(2), /^ 2 runs with unknown costs/);
});

test("the daily chart renders a column per day, and a bar only for days with spend", () => {
  const html = render(DailyChart, { daily: [{ day: "2026-01-01", usd: 0, runs: 0 }, { day: "2026-01-02", usd: 2, runs: 1 }] });
  assert.equal(html.match(/class="spend-col /g)?.length, 2);
  assert.equal(html.match(/class="spend-bar"/g)?.length, 1);
  assert.ok(!html.includes("spend-tip"), "no tip until a column is hovered");
});

test("repos: check commands ignore blank lines and stray spaces", () => {
  assert.deepEqual(parseCheckCommands("  npm test \n\n   \nnpm run typecheck"), ["npm test", "npm run typecheck"]);
  assert.deepEqual(parseCheckCommands(""), []);
});

test("repos: a row mentions open tasks only when there are some", () => {
  assert.equal(openTasksNote(0), "");
  assert.equal(openTasksNote(undefined), "");
  assert.equal(openTasksNote(2), " · 2 open");
  assert.equal(newTaskInstruction({ isFactory: true, name: "crane" }), "Research what Crane should build next to need me less");
  assert.equal(newTaskInstruction({ isFactory: false, name: "shop" }), "Investigate open maintenance work in shop");
});

test("diff view: the layout preference round-trips through localStorage, and survives a storage that refuses", () => {
  const held = new Map<string, string>();
  const storage = { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => void held.set(k, v) };
  Object.assign(globalThis, { localStorage: storage });
  try {
    assert.equal(savedDiffLayout(), "inline");
    saveDiffLayout("split");
    assert.equal(held.get("crane.diffLayout"), "split");
    assert.equal(savedDiffLayout(), "split");
    const refuse = () => { throw new Error("denied"); };
    Object.assign(globalThis, { localStorage: { getItem: refuse, setItem: refuse } });
    assert.equal(savedDiffLayout(), "inline");
    assert.doesNotThrow(() => saveDiffLayout("split"));
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("diff view: an open file dropped from a live diff falls back to the first", () => {
  const files = [{ path: "a" }, { path: "b" }];
  assert.equal(openFileIndex(files, "b"), 1);
  assert.equal(openFileIndex(files, "gone"), 0);
  assert.equal(openFileIndex(files, null), 0);
});

test("diff view: labels and notes", () => {
  assert.equal(fileStatusLabel({ status: "added" }), "New");
  assert.equal(fileStatusLabel({ status: "modified" }), null);
  assert.equal(filePathLabel({ path: "b", oldPath: "a" }), "a → b");
  assert.equal(filePathLabel({ path: "b", oldPath: null }), "b");
  const hunks = diffFile().hunks;
  assert.equal(noLinesNote({ binary: true, hunks, status: "modified" }), "A binary file. Its contents aren't shown.");
  assert.equal(noLinesNote({ binary: false, hunks: [], status: "renamed" }), "Moved, with its contents unchanged.");
  assert.equal(noLinesNote({ binary: false, hunks: [], status: "modified" }), "No line changes.");
  assert.equal(noLinesNote({ binary: false, hunks, status: "modified" }), null);
  assert.equal(inlineLineText({ kind: "add", text: "x" }), "+x");
  assert.equal(inlineLineText({ kind: "del", text: "x" }), "-x");
  assert.equal(inlineLineText({ kind: "context", text: "x" }), " x");
  assert.equal(inlineLineText({ kind: "note", text: "x" }), "x");
});

test("diff view: gutters fit the widest line number, and never shrink below two characters", () => {
  assert.equal(gutterWidth(diffFile()), "2ch");
  const wide = { hunks: [{ header: "", lines: [{ kind: "add", oldLine: null, newLine: 12345, text: "" }] }] };
  assert.equal(gutterWidth(wide as never), "5ch");
});

test("the file diff renders inline and side by side, and explains files with no lines", () => {
  const inline = render(FileDiff, { file: diffFile(), layout: "inline" });
  assert.match(inline, /class="diff diff-inline"/);
  assert.equal(inline.match(/class="diff-line /g)?.length, 3);
  assert.ok(!inline.includes("diff-sides"));
  const split = render(FileDiff, { file: diffFile(), layout: "split" });
  assert.match(split, /class="diff diff-split"/);
  assert.match(split, /class="diff-sides"/);
  assert.ok(split.includes("diff-pair"));
  const moved = render(FileDiff, { file: diffFile({ hunks: [], status: "renamed", oldPath: "src/old.ts" }), layout: "inline" });
  assert.match(moved, /Moved, with its contents unchanged\./);
  assert.match(moved, /src\/old\.ts → src\/a\.ts/);
  assert.ok(!moved.includes("role=\"region\""));
});

test("changed files open only when there's a diff, and mark the current one", () => {
  const files = [{ path: "a" }, diffFile({ path: "b" })];
  const plain = render(ChangedFiles, { files });
  assert.ok(!plain.includes("<button"));
  assert.equal(plain.match(/file-stat/g)?.length, 1, "only a loaded file has a stat");
  const open = render(ChangedFiles, { files, currentPath: "b", onChoose: () => {} });
  assert.equal(open.match(/<button/g)?.length, 2);
  assert.equal(open.match(/aria-current="true"/g)?.length, 1);
});

test("goal list: groups by urgency, skips empty groups, and folds only what's finished", () => {
  const groups = goalListGroups([{ status: "completed" }, { status: "active" }, { status: "blocked" }, { status: "needs_review" }]);
  assert.deepEqual(groups.map((g) => [g.title, g.goals.length, !!g.fold]), [["Needs you", 2, false], ["In progress", 1, false], ["Finished", 1, true]]);
  assert.deepEqual(goalListGroups([]), []);
  assert.equal(plannedText({ plannedTasks: 0 }), "Planning");
  assert.equal(plannedText({ plannedTasks: 2 }), "2 tasks planned");
  assert.deepEqual(listProgress({} as never), goalProgress([]));
});

test("goal decisions: who can edit and cancel", () => {
  assert.ok(isPlanEditable({ approvedAt: null, status: "needs_review" }));
  assert.ok(isPlanEditable({ approvedAt: null, status: "blocked" }));
  assert.ok(!isPlanEditable({ approvedAt: null, status: "researching" }));
  assert.ok(!isPlanEditable({ approvedAt: "2026-01-01", status: "blocked" }));
  assert.ok(isCancellable({ status: "active" }));
  assert.ok(!isCancellable({ status: "completed" }));
  assert.ok(!isCancellable({ status: "cancelled" }));
});

test("goal plan: a task resolves through the goal's links", () => {
  const found = { id: "t-1" } as Task;
  const g = { tasks: [{ key: "a", taskId: "t-1" }] } as Pick<Goal, "tasks">;
  assert.equal(taskForKey(g, [found], "a"), found);
  assert.equal(taskForKey(g, [found], "missing"), undefined);
});

test("goal plan: edits are immutable, new keys never collide, and removing a task clears dependencies on it", () => {
  const start = plan([task("a"), task("task-3"), task("b", { dependsOn: ["a", "task-3"] })]);
  assert.equal(patchTask(start, "a", { title: "New" }).tasks[0]!.title, "New");
  assert.equal(start.tasks[0]!.title, "Task a");
  const added = addTask(start);
  assert.equal(added.tasks.at(-1)!.key, "task-4", "skips a key already taken");
  assert.equal(start.tasks.length, 3);
  const removed = removeTask(start, "a");
  assert.deepEqual(removed.tasks.map((t) => t.key), ["task-3", "b"]);
  assert.deepEqual(removed.tasks[1]!.dependsOn, ["task-3"]);
  const t = task("c", { dependsOn: ["a"] });
  assert.deepEqual(withDependency(t, "b", true), ["a", "b"]);
  assert.deepEqual(withDependency(t, "a", false), []);
  assert.ok(canAddTask(start));
  assert.ok(!canAddTask(plan(Array.from({ length: 40 }, (_, i) => task(`t${i}`)))));
});

test("goal plan: blank lines never reach the saved plan", () => {
  assert.deepEqual(splitLines("a\n\nb"), ["a", "", "b"]);
  const dirty: GoalPlan = { ...plan([task("a", { acceptance: ["x", " "], acceptanceChecks: ["", "npm test"] }), task("b")]), improvements: ["", "y"] };
  const clean = withoutBlankLines(dirty);
  assert.deepEqual(clean.improvements, ["y"]);
  assert.deepEqual(clean.tasks[0]!.acceptance, ["x"]);
  assert.deepEqual(clean.tasks[0]!.acceptanceChecks, ["npm test"]);
  assert.equal(clean.tasks[1]!.acceptanceChecks, undefined);
});

test("goal decision sheet shows what each decision needs", () => {
  const sheet = (mode: string) => render(GoalDecision, { goal: goal(), mode, onClose: () => {}, onSaved: () => {} });
  assert.match(sheet("feedback"), /What should change\?/);
  assert.match(sheet("feedback"), /Review feedback/);
  assert.match(sheet("approve"), /class="goal-check"/);
  assert.match(sheet("approve"), /2 tasks will enter the queue/);
  assert.match(sheet("cancel"), /Already merged changes remain/);
  assert.ok(!sheet("cancel").includes("goal-check"));
});

test("selectors in the goals capture sequence still render", () => {
  const needsReview = { goal: goal(), tasks: [], research: null };
  const page = render(GoalView, { detail: needsReview, pollError: null, refresh: () => {} });
  for (const action of ["approve", "feedback", "edit"]) assert.ok(page.includes(`data-goal-action="${action}"`), action);
  const editor = render(PlanEditor, { goal: goal(), onClose: () => {}, onSaved: () => {} });
  assert.equal(editor.match(/class="goal-editor-task"/g)?.length, 2);
  assert.ok(editor.includes("sheet-pane-foot"));
  const approve = render(GoalDecision, { goal: goal(), mode: "approve", onClose: () => {}, onSaved: () => {} });
  assert.ok(approve.includes('role="dialog"'));
  assert.ok(approve.includes('class="goal-check"'));
});

test("the goal page drops plan actions after approval, and keeps cancelling until the goal ends", () => {
  const view = (change: Partial<Goal>) => render(GoalView, { detail: { goal: goal(change), tasks: [], research: null }, pollError: null, refresh: () => {} });
  const approved = view({ approvedAt: "2026-01-01", status: "active" });
  assert.ok(!approved.includes("data-goal-action"));
  assert.ok(approved.includes("goal-progress"));
  assert.ok(approved.includes("Cancel goal"));
  assert.ok(!view({ approvedAt: "2026-01-01", status: "completed" }).includes("Cancel goal"));
  assert.ok(!view({ status: "researching", plan: null }).includes("data-goal-action"));
});

test("shell: the factory pill names the state and what a tap does", () => {
  assert.deepEqual(factoryPill({ running: false, paused: false }), { label: "Off", title: "The factory is off", hint: "", dot: "" });
  assert.deepEqual(factoryPill({ running: true, paused: true }), { label: "Paused", title: "Resume the factory", hint: " · resume", dot: "dot-paused" });
  assert.deepEqual(factoryPill({ running: true, paused: false }), { label: "Running", title: "Pause the factory", hint: " · pause", dot: "dot-on" });
});

test("shell: Cmd/Ctrl+K works anywhere, a bare N only outside fields", () => {
  const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) => ({ key: k, metaKey: false, ctrlKey: false, ...mods });
  assert.ok(isInstructShortcut(key("k", { metaKey: true }), "INPUT"));
  assert.ok(isInstructShortcut(key("k", { ctrlKey: true }), "BODY"));
  assert.ok(!isInstructShortcut(key("k"), "BODY"));
  assert.ok(isInstructShortcut(key("n"), "BODY"));
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) assert.ok(!isInstructShortcut(key("n"), tag), tag);
  assert.ok(!isInstructShortcut(key("n", { metaKey: true }), "BODY"));
});

test("shell: ?instruct= opens the sheet pre-filled, even when empty", () => {
  assert.deepEqual(instructFromSearch("?instruct=Fix%20it"), { text: "Fix it" });
  assert.deepEqual(instructFromSearch("?instruct="), { text: "" });
  assert.equal(instructFromSearch("?other=1"), null);
});

test("shell: which dashboard notice shows", () => {
  const factory = (change = {}) => ({ uiBuild: "b", uiOutdated: false, factoryOutdated: false, ...change });
  const built = { built: true, loadedUi: "a" };
  assert.equal(dashboardNotice(undefined, built), null);
  assert.equal(dashboardNotice(factory(), built), "reload", "Crane serves a newer build than this page loaded");
  assert.equal(dashboardNotice(factory(), { built: false, loadedUi: "a" }), null, "the dev server is always fresh");
  assert.equal(dashboardNotice(factory({ uiBuild: null }), built), null);
  const same = { built: true, loadedUi: "b" };
  assert.equal(dashboardNotice(factory(), same), null);
  assert.equal(dashboardNotice(factory({ uiOutdated: true }), same), "outdated");
  assert.equal(dashboardNotice(factory({ uiOutdated: true, factoryOutdated: true }), same), null, "the factory notice's build covers it");
  assert.equal(dashboardNotice(factory({ uiOutdated: true }), { built: false, loadedUi: "b" }), null);
  assert.equal(dashboardNotice(factory({ uiOutdated: true }), { built: true, loadedUi: undefined }), "outdated");
  assert.equal(dashboardNotice(factory({ uiOutdated: true, factoryOutdated: true }), built), "reload", "a newer build wins over the factory notice");
});

test("site: every task counts once, in its status's zone", () => {
  const t = (id: string, status: TaskStatus) => ({ id, status }) as never;
  const tasks = siteTasks({ inFlight: [t("a", "running")], needsReview: [t("b", "needs_review"), t("a", "running")], recent: [t("b", "needs_review"), t("c", "merged")] });
  assert.deepEqual(tasks.map((task) => (task as { id: string }).id), ["a", "b", "c"]);
  const counts = zoneCounts([{ status: "running" }, { status: "merged" }, { status: "merged" }]);
  assert.equal(counts.working, 1);
  assert.equal(counts.shipped, 2);
  assert.equal(counts.queued, 0);
  assert.equal(zoneSummary(counts), "Working: 1, Shipped: 2");
  assert.equal(zoneSummary(zoneCounts([])), "");
});
