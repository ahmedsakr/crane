import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DriverInfo, Repo, TaskDraft } from "@crane/contracts";
import { canPreApprove, instructExamples, mergeDraft } from "../web/src/lib/instruct-draft.ts";

// tsx applies the root tsconfig only inside `src`, so web's .tsx files compile to React.createElement here.
Object.assign(globalThis, { React });
// By computed path: these import web modules without extensions, which only web's own tsconfig accepts.
const webModule = <Name extends string>(path: string): Promise<Record<Name, ComponentType<never>>> =>
  import(new URL(`../web/src/components/${path}`, import.meta.url).href);
const { InstructChoices } = await webModule<"InstructChoices">("InstructChoices.tsx");
const { InstructOptions } = await webModule<"InstructOptions">("InstructOptions.tsx");
const { ScheduleFields } = await webModule<"ScheduleFields">("ScheduleFields.tsx");

const render = (component: ComponentType<never>, props: object) => renderToStaticMarkup(h(component, props as never));

const CHOSEN = "You chose this";
const draft: TaskDraft = {
  kind: "maintenance",
  title: "Fix the tests",
  brief: "Fix the tests",
  repoId: "app",
  autonomy: "propose",
  why: { kind: "guessed kind", repo: "guessed repo", autonomy: "guessed autonomy" },
};
const repos = [
  { id: "app", name: "storefront", path: "/repos/storefront", isFactory: false },
  { id: "crane", name: "crane", path: "/repos/crane", isFactory: true },
] as Repo[];

test("mergeDraft: nothing to merge until the factory has read the instruction", () => {
  assert.equal(mergeDraft(null, { kind: "repo_feature" }, repos), null);
});

test("mergeDraft: with no overrides, the factory's guesses stand", () => {
  assert.deepEqual(mergeDraft(draft, {}, repos), draft);
});

test("mergeDraft: an override replaces the guess and says the operator chose it", () => {
  const kind = mergeDraft(draft, { kind: "repo_feature" }, repos);
  assert.equal(kind?.kind, "repo_feature");
  assert.deepEqual(kind?.why, { ...draft.why, kind: CHOSEN });

  const autonomy = mergeDraft(draft, { autonomy: "act" }, repos);
  assert.equal(autonomy?.autonomy, "act");
  assert.deepEqual(autonomy?.why, { ...draft.why, autonomy: CHOSEN });

  const repo = mergeDraft(draft, { repoId: "other" }, repos);
  assert.equal(repo?.repoId, "other");
  assert.deepEqual(repo?.why, { ...draft.why, repo: CHOSEN });
});

test("mergeDraft: clearing the repo still counts as the operator's choice", () => {
  const merged = mergeDraft(draft, { repoId: null }, repos);
  assert.equal(merged?.repoId, null);
  assert.equal(merged?.why.repo, CHOSEN);
});

test("mergeDraft: a factory repo forces a factory feature, guessed or chosen", () => {
  const guessed = mergeDraft({ ...draft, repoId: "crane" }, {}, repos);
  assert.equal(guessed?.kind, "factory_feature");

  const chosenRepo = mergeDraft(draft, { repoId: "crane" }, repos);
  assert.equal(chosenRepo?.kind, "factory_feature");

  const chosenKind = mergeDraft(draft, { repoId: "crane", kind: "maintenance" }, repos);
  assert.equal(chosenKind?.kind, "factory_feature");
});

test("mergeDraft: other repos, no repo and unknown repos keep the kind", () => {
  assert.equal(mergeDraft(draft, {}, repos)?.kind, "maintenance");
  assert.equal(mergeDraft({ ...draft, repoId: null }, {}, repos)?.kind, "maintenance");
  assert.equal(mergeDraft({ ...draft, repoId: "gone" }, {}, repos)?.kind, "maintenance");
});

test("mergeDraft: leaves the draft it was given alone", () => {
  const before = structuredClone(draft);
  mergeDraft(draft, { repoId: "crane", autonomy: "act" }, repos);
  assert.deepEqual(draft, before);
});

test("canPreApprove: investigate-only work has nothing to merge", () => {
  assert.equal(canPreApprove("observe"), false);
  assert.equal(canPreApprove("propose"), true);
  assert.equal(canPreApprove("act"), true);
});

test("instructExamples: names the operator's own repo, not the factory", () => {
  assert.match(instructExamples(repos).join("\n"), /flaky in storefront/);
  assert.match(instructExamples([{ name: "crane", isFactory: true }]).join("\n"), /flaky in my-app/);
});

const driver = (name: string, label: string, isDefault = false) =>
  ({ name, label, isDefault, available: true, hint: `${label} hint` }) as unknown as DriverInfo;

const choices = (drivers: DriverInfo[]) =>
  render(InstructChoices, { final: draft, repos, override: () => {}, drivers, driver: null, onDriver: () => {} });

test("InstructChoices: the agent is only asked about when more than one is installed", () => {
  assert.doesNotMatch(choices([]), /Agent/);
  assert.doesNotMatch(choices([driver("claude", "Claude Code", true)]), /Agent/);
  const both = choices([driver("claude", "Claude Code", true), driver("codex", "Codex")]);
  assert.match(both, /Agent/);
  assert.match(both, /Your default agent/);
});

test("InstructChoices: says when no repo is chosen yet", () => {
  const html = render(InstructChoices, {
    final: { ...draft, repoId: null }, repos, override: () => {}, drivers: [], driver: null, onDriver: () => {},
  });
  assert.match(html, /Choose a repo/);
  assert.match(html, /choice-btn unset/);
});

test("InstructOptions: pre-approval only shows for work that can merge", () => {
  const settings = {
    driver: null,
    gates: { prerequisites: "", acceptance: "", acceptanceChecks: "" },
    lookouts: [],
    startTime: null,
    preApprove: false,
  };
  const options = (preApprovable: boolean) =>
    render(InstructOptions, { settings, change: () => {}, preApprovable, busy: false });
  assert.match(options(true), /Pre-approve this task/);
  assert.doesNotMatch(options(false), /Pre-approve this task/);
});

test("ScheduleFields: the line under the choice says what it means or what's wrong", () => {
  const line = (value: string | null) => render(ScheduleFields, { value, onChange: () => {} });
  assert.match(line(null), /Starts as soon as an agent is free/);
  assert.match(line("2000-01-01T09:00"), /role="alert">Choose a start time in the future/);
  assert.match(line("2999-01-01T09:00"), /Your timezone:/);
});
