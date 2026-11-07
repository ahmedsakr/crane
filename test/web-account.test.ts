import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH, type AuthStatus, type OperatorProfile, type OperatorSession } from "@crane/contracts";
import { createAuthStore } from "../web/src/lib/auth.ts";

// tsx applies the root tsconfig only inside `src`, so web's .tsx files compile to React.createElement here.
Object.assign(globalThis, { React });
// By computed path: these import web modules without extensions, which only web's own tsconfig accepts.
const webModule = <T>(path: string): Promise<T> => import(new URL(`../web/src/${path}`, import.meta.url).href);
type PasswordDraft = { current: string; next: string; confirm: string };
const account = await webModule<{
  devicesLabel: (n: number) => string;
  orderSessions: (sessions: OperatorSession[]) => OperatorSession[];
  deviceName: (s: OperatorSession) => string;
  deviceDetail: (s: OperatorSession) => string;
  passwordProblem: (draft: PasswordDraft) => string | null;
  nameProblem: (name: string) => string | null;
}>("lib/account.ts");
const { until } = await webModule<{ until: (iso: string | null | undefined) => string }>("lib/format.ts");
const { AccountSummary } = await webModule<{ AccountSummary: ComponentType<never> }>("components/account/AccountSummary.tsx");
const { DeviceList } = await webModule<{ DeviceList: ComponentType<never> }>("components/account/DeviceList.tsx");
const { PasswordForm } = await webModule<{ PasswordForm: ComponentType<never> }>("components/account/PasswordForm.tsx");

const render = (component: ComponentType<never>, props: object) => renderToStaticMarkup(h(component, props as never));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const operator: OperatorProfile = { id: "o-1", username: "robin", name: "Robin Park", role: "admin", createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: null };
const session = (id: string, over: Partial<OperatorSession> = {}): OperatorSession => ({
  id, operatorId: "o-1", current: false, createdAt: minutesAgo(600), lastSeenAt: minutesAgo(10), expiresAt: daysFromNow(29), client: "Firefox on macOS", ...over,
});
const here = session("s-here", { current: true, client: "Chrome on Linux", lastSeenAt: minutesAgo(0) });
const phone = session("s-phone", { client: "Safari on iOS", lastSeenAt: minutesAgo(180) });
const old = session("s-old", { client: null, lastSeenAt: minutesAgo(3000) });

test("web account: device counts, order and details", () => {
  assert.equal(account.devicesLabel(1), "1 device signed in");
  assert.equal(account.devicesLabel(3), "3 devices signed in");
  assert.deepEqual(account.orderSessions([old, phone, here]).map((s) => s.id), ["s-here", "s-phone", "s-old"]);
  assert.equal(account.deviceName(old), "Unknown browser");
  assert.equal(account.deviceDetail(here), "Active now · Expires in 29d");
  assert.equal(account.deviceDetail(phone), "Last seen 3h ago · Expires in 29d");
});

test("web account: expiry reads forward in ago's units", () => {
  assert.equal(until(null), "");
  assert.equal(until(new Date(Date.now() - 5_000).toISOString()), "now");
  assert.equal(until(new Date(Date.now() + 10 * 60_000).toISOString()), "in 10m");
  assert.equal(until(new Date(Date.now() + 5 * 3_600_000).toISOString()), "in 5h");
  assert.equal(until(daysFromNow(7)), "in 7d");
});

test("web account: the password form refuses a missing current, short or mismatched new password before sending", () => {
  const long = "x".repeat(MIN_PASSWORD_LENGTH);
  assert.equal(account.passwordProblem({ current: "", next: long, confirm: long }), "Enter your current password.");
  assert.equal(account.passwordProblem({ current: "old", next: long.slice(1), confirm: long.slice(1) }),
    `Choose a new password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  assert.equal(account.passwordProblem({ current: "old", next: long, confirm: `${long}y` }), "The new passwords don't match.");
  assert.equal(account.passwordProblem({ current: "old", next: long, confirm: long }), null);
});

test("web account: names follow the server's rule", () => {
  assert.equal(account.nameProblem("  "), "Enter a name.");
  assert.equal(account.nameProblem("x".repeat(MAX_NAME_LENGTH + 1)), `Use at most ${MAX_NAME_LENGTH} characters.`);
  assert.equal(account.nameProblem(` ${"x".repeat(MAX_NAME_LENGTH)} `), null);
  assert.equal(account.nameProblem("Sam\u0007"), "Use letters, numbers and punctuation only.");
  assert.equal(account.nameProblem("Sam Lee"), null);
});

test("web account: a rename updates the signed-in operator everywhere, and only theirs", async () => {
  const status: AuthStatus = { required: true, signedIn: true, setUp: true, operator, session: here };
  const store = createAuthStore({ session: async () => status, signOut: async () => status });
  await store.refresh();
  let published = 0;
  store.subscribe(() => published++);
  store.setOperator({ ...operator, id: "o-2", name: "Someone else" });
  assert.equal(published, 0);
  store.setOperator({ ...operator, name: "Sam Lee" });
  assert.equal(store.get().status?.operator?.name, "Sam Lee");
  assert.equal(store.get().status?.session?.id, "s-here");
  assert.equal(published, 1);
});

test("web account: the summary leads with name, role and how many devices are signed in", () => {
  const html = render(AccountSummary, { operator, sessions: [here, phone], onRenamed() {}, onDevices() {}, onPassword() {} });
  assert.match(html, /Your account/);
  assert.match(html, /Robin Park/);
  assert.match(html, /Admin · <span class="mono">robin<\/span>/);
  assert.match(html, /2 devices signed in/);
  assert.match(html, /This device: Chrome on Linux/);
  assert.match(html, /Change password/);
  // Before the list loads, the link still opens devices.
  assert.match(render(AccountSummary, { operator, sessions: null, onRenamed() {}, onDevices() {}, onPassword() {} }), />Devices</);
});

test("web account: devices show client, last seen and expiry, this one first and marked", () => {
  const html = render(DeviceList, { sessions: [phone, here], error: null, actions: {}, onBack() {} });
  assert.ok(html.indexOf("Chrome on Linux") < html.indexOf("Safari on iOS"));
  assert.equal(html.match(/This device/g)?.length, 1);
  assert.match(html, /Last seen 3h ago · Expires in 29d/);
  assert.match(html, /aria-label="Sign out this device"/);
  assert.match(html, /aria-label="Sign out Safari on iOS"/);
  assert.match(html, /<button[^>]*>Sign out other devices<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Sign out other devices/);
  // Alone, there's nothing else to sign out.
  assert.match(render(DeviceList, { sessions: [here], error: null, actions: {}, onBack() {} }), /<button[^>]*disabled=""[^>]*>Sign out other devices/);
});

test("web account: change password has current, new and confirm fields for password managers", () => {
  const html = render(PasswordForm, { username: "robin", onBack() {}, onChanged() {} });
  assert.equal(html.match(/autocomplete="current-password"/gi)?.length, 1);
  assert.equal(html.match(/autocomplete="new-password"/gi)?.length, 2);
  assert.match(html, /Confirm new password/);
  assert.match(html, new RegExp(`At least ${MIN_PASSWORD_LENGTH} characters`));
  assert.match(html, /aria-label="Back"/);
});
