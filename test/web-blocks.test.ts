import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement as h, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { runAction, useAction, type ActionEffects, type ActionStep } from "../web/src/lib/action.ts";
import { ToastContext, type ToastMessage } from "../web/src/lib/toast.ts";

// tsx applies the root tsconfig only inside `src`, so web's .tsx files compile to React.createElement here.
Object.assign(globalThis, { React });
const { Section } = await import("../web/src/components/Section.tsx");
// By computed path: these import web modules without extensions, which only web's own tsconfig accepts.
const webModule = (path: string): Promise<Record<string, ComponentType<never>>> =>
  import(new URL(`../web/src/components/${path}`, import.meta.url).href);
const { StatusChip } = await webModule("Status.tsx");
const { TaskRow } = await webModule("TaskRow.tsx");
const { BlockedItem } = await webModule("BlockedItem.tsx");

const render = (component: ComponentType<never>, props: object) =>
  renderToStaticMarkup(h(MemoryRouter, null, h(component, props as never)));

function recorder() {
  const log: string[] = [];
  const effects: ActionEffects = {
    setBusy: (key) => log.push(`busy:${key}`),
    toast: (toast) => log.push(`toast:${toast.text}`),
    refresh: () => log.push("refresh"),
  };
  return { log, effects };
}

async function ran<R>(step: Omit<ActionStep<R>, "key">) {
  const { log, effects } = recorder();
  await runAction(effects, { key: "save", ...step });
  return log;
}

test("runAction: a success marks busy, toasts, refreshes, then clears busy, in that order", async () => {
  assert.deepEqual(await ran({ action: async () => "result", done: "Saved" }), ["busy:save", "toast:Saved", "refresh", "busy:null"]);
});

test("runAction: `after` gets the result and runs after the refresh", async () => {
  const { log, effects } = recorder();
  await runAction(effects, { key: "k", action: async () => 7, after: (n) => log.push(`after:${n}`) });
  assert.deepEqual(log, ["busy:k", "refresh", "after:7", "busy:null"]);
});

test("runAction: stays busy until the action settles", async () => {
  const { log, effects } = recorder();
  let finish!: () => void;
  const pending = runAction(effects, { key: "k", action: () => new Promise<void>((resolve) => { finish = resolve; }) });
  assert.deepEqual(log, ["busy:k"]);
  finish();
  await pending;
  assert.equal(log.at(-1), "busy:null");
});

test("runAction: `done` can build its toast from the result, link included", async () => {
  const shown: ToastMessage[] = [];
  const toast = { text: "Follow-up queued", link: { to: "/tasks/t-1", label: "Open" } };
  await runAction({ setBusy: () => {}, toast: (t) => shown.push(t) }, {
    key: "k",
    action: async () => ({ id: "t-1" }),
    done: (r) => ({ ...toast, link: { ...toast.link, to: `/tasks/${r.id}` } }),
  });
  assert.deepEqual(shown, [toast]);
});

test("runAction: with no `done`, or one that returns nothing, a success shows no toast but still refreshes", async () => {
  assert.deepEqual(await ran({ action: async () => {} }), ["busy:save", "refresh", "busy:null"]);
  assert.deepEqual(await ran({ action: async () => {}, done: () => undefined }), ["busy:save", "refresh", "busy:null"]);
});

test("runAction: a failure toasts the error, skips the refresh and follow-up, clears busy, and doesn't throw", async () => {
  const { log, effects } = recorder();
  await runAction(effects, {
    key: "k",
    action: async () => { throw new Error("No such task"); },
    done: "Saved",
    after: () => log.push("after"),
  });
  assert.deepEqual(log, ["busy:k", "toast:No such task", "busy:null"]);
});

test("runAction: an error thrown while refreshing or following up is shown too", async () => {
  const { log, effects } = recorder();
  await runAction(effects, { key: "k", action: async () => {}, after: () => { throw new Error("Lost it"); } });
  assert.deepEqual(log, ["busy:k", "refresh", "toast:Lost it", "busy:null"]);
});

test("useAction: starts idle, and runs through the toast context and the given refresh", async () => {
  const log: string[] = [];
  let hook!: ReturnType<typeof useAction>;
  const Probe = () => {
    hook = useAction(() => log.push("refresh"));
    return null;
  };
  const toast = (t: ToastMessage | null) => { log.push(`toast:${t?.text}`); };
  renderToStaticMarkup(h(ToastContext.Provider, { value: toast }, h(Probe)));
  assert.equal(hook.busy, null);

  const seen: number[] = [];
  await hook.run("k", async () => 3, (n) => ({ text: `Got ${n}` }), (n) => seen.push(n));
  await hook.run("k", async () => { throw new Error("Nope"); });
  assert.deepEqual(log, ["toast:Got 3", "refresh", "toast:Nope"]);
  assert.deepEqual(seen, [3]);
});

test("Section: renders the hand-written markup it replaces", () => {
  const section = (props: { id?: string; className?: string; title: ReactNode; aside?: ReactNode }, body?: ReactNode) =>
    renderToStaticMarkup(h(Section, props, body));
  assert.equal(section({ id: "in-flight", title: "In flight" }, h("p", null, "Body")),
    '<section class="section" aria-labelledby="in-flight"><div class="section-head"><h2 class="section-title" id="in-flight">In flight</h2></div><p>Body</p></section>');
  assert.equal(section({ title: "Activity" }),
    '<section class="section"><div class="section-head"><h2 class="section-title">Activity</h2></div></section>');
  assert.equal(section({ id: "crew-active", className: "crew-section", title: "Active", aside: h("span", { className: "muted" }, "Note") }),
    '<section class="section crew-section" aria-labelledby="crew-active"><div class="section-head"><h2 class="section-title" id="crew-active">Active</h2><span class="muted">Note</span></div></section>');
});

test("StatusChip: each status keeps its class and label", () => {
  const expected = {
    needs_review: "chip chip-crane",
    done: "chip chip-ok",
    approved: "chip chip-ok",
    merged: "chip chip-ok",
    failed: "chip chip-bad",
    queued: "chip",
    running: "chip",
  };
  for (const [status, cls] of Object.entries(expected)) {
    const html = render(StatusChip!, { status });
    assert.ok(html.startsWith(`<span class="${cls}"><span class="dot dot-${status}" aria-hidden="true"></span>`), html);
  }
});

const summary = { id: "t-1", title: "A task", kind: "repo_feature", createdAt: "2026-01-01T00:00:00Z", startedAt: null, finishedAt: null, scheduledAt: null };

test("TaskRow: running and merging tasks say so, and others show their status label", () => {
  const meta = (status: string) => render(TaskRow!, { m: { ...summary, status }, repoName: "crane" });
  assert.match(meta("running"), />crane · Repo feature · Working now</);
  assert.match(meta("merging"), />crane · Repo feature · Merging now</);
  assert.match(meta("failed"), />crane · Repo feature · Failed</);
  assert.ok(meta("queued").includes('<a class="row" href="/tasks/t-1"'));
});

test("TaskRow: a scheduled task leads with its start time and may wrap", () => {
  const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
  const html = render(TaskRow!, { m: { ...summary, status: "queued", scheduledAt }, repoName: "crane" });
  assert.match(html, /white-space:normal[^>]*>Scheduled for [^<]+ · crane · Repo feature</);
});

test("BlockedItem: says how often a command was blocked", () => {
  const blocked = { label: "npm publish", repoId: "r", repoName: "crane", rule: "Bash(npm publish)", lastAt: "2026-01-01T00:00:00Z", lastTaskId: "t-1" };
  const often = (tasks: number, times: number) => render(BlockedItem!, { b: { ...blocked, tasks, times }, onDone: () => {} });
  assert.match(often(3, 5), /Blocked in 3 tasks · /);
  assert.match(often(1, 4), /Blocked 4 times · /);
  assert.match(often(1, 1), /Blocked once · /);
});
