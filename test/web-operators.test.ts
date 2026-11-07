import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InviteCheck, InviteSummary, OperatorSummary } from "@crane/contracts";
import { USERNAME_PATTERN } from "@crane/contracts";

Object.assign(globalThis, { React });
// Computed paths let web modules use web's extensionless imports, as in the existing web suites.
const webModule = <T>(path: string): Promise<T> => import(new URL(`../web/src/${path}`, import.meta.url).href);
type JoinDraft = { name: string; username: string; password: string; confirm: string };
const { INVALID_LINK, USERNAME_HINT, USERNAME_INPUT_PATTERN, inviteChecker, joinProblem, linkFailure, takeInviteToken } = await webModule<{
  INVALID_LINK: string;
  USERNAME_HINT: string;
  USERNAME_INPUT_PATTERN: string;
  inviteChecker: (token: string, check: (token: string) => Promise<InviteCheck>) => (retry?: boolean) => Promise<InviteCheck>;
  joinProblem: (kind: InviteCheck["kind"], draft: JoinDraft) => string | null;
  linkFailure: (error: unknown) => { invalid: boolean; message: string };
  takeInviteToken: (location: Pick<Location, "hash" | "pathname" | "search">, history: Pick<History, "state" | "replaceState">) => string;
}>("lib/join.ts");
const { absoluteInviteLink, invitedAs, pendingLinkLabel } = await webModule<{
  absoluteInviteLink: (origin: string, path: string) => string;
  invitedAs: (invite: InviteCheck) => string;
  pendingLinkLabel: (invite: InviteSummary) => string;
}>("lib/operators.ts");
const { OperatorList } = await webModule<{ OperatorList: ComponentType<never> }>("pages/operators/OperatorList.tsx");
const { OperatorActions, RemoveOperator } = await webModule<{
  OperatorActions: ComponentType<never>; RemoveOperator: ComponentType<never>;
}>("pages/operators/OperatorActions.tsx");
const { InviteForm } = await webModule<{ InviteForm: ComponentType<never> }>("pages/operators/InviteSheet.tsx");
const { LinkResult } = await webModule<{ LinkResult: ComponentType<never> }>("pages/operators/LinkResult.tsx");
const { PendingInvites } = await webModule<{ PendingInvites: ComponentType<never> }>("pages/operators/PendingInvites.tsx");
const { JoinView } = await webModule<{ JoinView: ComponentType<never> }>("pages/join/JoinView.tsx");
const render = (component: ComponentType<never>, props: object) => renderToStaticMarkup(h(component, props as never));
const noop = () => {};
const operator: OperatorSummary = {
  id: "o-1", name: "Robin Park", username: "robin", role: "admin", devices: 2,
  createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
};
const invite: InviteSummary = {
  id: "i-1", kind: "join", role: "operator", name: "Sam", forOperator: null, invitedBy: "Robin",
  createdAt: operator.createdAt, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
};
const checked: InviteCheck = { kind: "join", role: "operator", name: "Sam", username: null, invitedBy: "Robin", expiresAt: invite.expiresAt };

test("operator links use this origin, with the secret only in the fragment", () => {
  const full = absoluteInviteLink("https://crane.example", "/join#private-token");
  assert.equal(full, "https://crane.example/join#private-token");
  const parsed = new URL(full);
  assert.equal(parsed.pathname, "/join");
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "#private-token");
});

test("join entry clears the fragment without losing router state, the path or the query", () => {
  const location = { pathname: "/join", search: "?theme=dark", hash: "#private-token" };
  const state = { idx: 2, key: "router-key" };
  const calls: unknown[][] = [];
  const history = { state, replaceState: (...args: unknown[]) => { calls.push(args); location.hash = ""; } };
  assert.equal(takeInviteToken(location, history), "private-token");
  assert.equal(location.hash, "");
  assert.deepEqual(calls, [[state, "", "/join?theme=dark"]]);
  assert.equal(takeInviteToken(location, history), "");
  assert.equal(calls.length, 1);
});

test("join entry shares its initial check through effect replay, and retries explicitly", async () => {
  const tokens: string[] = [];
  const check = inviteChecker("secret", async (token) => { tokens.push(token); return checked; });
  const first = check();
  assert.equal(check(), first);
  assert.deepEqual(await first, checked);
  assert.equal(check(), first);
  await check(true);
  assert.deepEqual(tokens, ["secret", "secret"]);
});

test("join copy names the inviter and role, with a host fallback", () => {
  assert.equal(invitedAs(checked), "Robin invited you as an operator");
  assert.equal(invitedAs({ ...checked, role: "admin" }), "Robin invited you as an admin");
  assert.equal(invitedAs({ ...checked, invitedBy: null }), "An admin invited you as an operator");
  assert.equal(pendingLinkLabel(invite), "Sam · Operator");
  assert.equal(pendingLinkLabel({ ...invite, kind: "reset", forOperator: operator }), "Password reset for robin");
});

test("join validates names, usernames and matching passwords; resets need no identity fields", () => {
  const draft = { name: "Sam", username: "sam.k", password: "a long new password", confirm: "a long new password" };
  assert.equal(joinProblem("join", draft), null);
  assert.equal(joinProblem("join", { ...draft, name: " " }), "Enter a name.");
  assert.equal(joinProblem("join", { ...draft, username: "a" }), USERNAME_HINT);
  assert.equal(joinProblem("join", { ...draft, username: "-sam" }), USERNAME_HINT);
  assert.match(joinProblem("join", { ...draft, password: "short" })!, /at least 12 characters/);
  assert.equal(joinProblem("join", { ...draft, confirm: "different" }), "The passwords don't match.");
  assert.equal(joinProblem("reset", { ...draft, name: "", username: "" }), null);
});

test("the browser's v-mode username pattern compiles and agrees with the shared username rule", () => {
  const browserPattern = new RegExp(USERNAME_INPUT_PATTERN, "v");
  for (const username of ["sam", "sam.k", "sam_k", "sam-k", "s00", "a".repeat(32), "a".repeat(33), "ab", "-sam", "SAM", "s!m"]) {
    assert.equal(browserPattern.test(username), USERNAME_PATTERN.test(username), username);
  }
});

test("invalid links stay distinct from rate limits and recoverable failures", () => {
  assert.deepEqual(linkFailure({ status: 401 }), { invalid: true, message: INVALID_LINK });
  assert.deepEqual(linkFailure({ status: 429, body: { retryAfterSeconds: 61 } }),
    { invalid: false, message: "Too many attempts. Try again in 2 minutes." });
  assert.deepEqual(linkFailure(new Error("Can't reach Crane")), { invalid: false, message: "Can't reach Crane" });
});

test("operator list shows names, usernames, roles, last seen and devices; only admins get row actions", () => {
  const props = { operators: [operator], onChoose: noop };
  const admin = render(OperatorList, { ...props, admin: true });
  for (const text of ["Robin Park", "robin", "Admin", "Last seen 1m ago", "2 devices signed in"]) assert.ok(admin.includes(text), text);
  assert.match(admin, /<button[^>]*data-operator="robin"/);
  const readOnly = render(OperatorList, { ...props, admin: false });
  assert.doesNotMatch(readOnly, /<button|Make admin|Remove|Reset password|Sign out/);
  assert.match(readOnly, /Robin Park/);
});

test("invite form offers both roles, an optional name and a single creation action", () => {
  const html = render(InviteForm, { onIssued: noop });
  assert.match(html, /Invite operator/);
  assert.match(html, /<option value="operator" selected="">Operator/);
  assert.match(html, /<option value="admin">Admin/);
  assert.match(html, /Name <span[^>]*>\(optional\)/);
  assert.match(html, />Create invite<\/button>/);
});

test("issuing a link shows its copy control, once-only warning and the right privacy and expiry copy", () => {
  Object.assign(globalThis, { window: { location: { origin: "https://crane.example" } } });
  try {
    const props = { issued: { invite, token: "secret", path: "/join#secret" }, onDone: noop };
    const html = render(LinkResult, props);
    assert.match(html, /https:\/\/crane.example\/join#secret/);
    assert.match(html, /Copy this link now. It won&#x27;t be shown again/);
    assert.match(html, /Expires in 7 days. Anyone with this link can join, so send it privately./);
    assert.match(html, />Copy<\/button>/);
    const reset = render(LinkResult, { ...props, issued: { ...props.issued, invite: { ...invite, kind: "reset" } } });
    assert.match(reset, /Expires in 24 hours/);
    assert.match(reset, /Anyone with this link can change the password/);
  } finally { Reflect.deleteProperty(globalThis, "window"); }
});

test("operator sheet offers the matching role action and removal confirmation names the person", () => {
  const props = { busy: false, actions: {} };
  const admin = render(OperatorActions, { ...props, operator });
  for (const text of ["Make operator", "Reset password", "Sign out everywhere", "Remove"]) assert.ok(admin.includes(text), text);
  assert.doesNotMatch(admin, /Make admin/);
  assert.match(render(OperatorActions, { ...props, operator: { ...operator, role: "operator" } }), /Make admin/);
  const confirmation = render(RemoveOperator, { operator, onBack: noop });
  assert.match(confirmation, /Remove Robin Park\?/);
  assert.match(confirmation, /robin/);
  assert.match(confirmation, /Their devices will be signed out/);
});

test("pending links show expiry and revocation, never the secret", () => {
  const html = render(PendingInvites, { invites: [invite], error: null, onChanged: noop });
  assert.match(html, /Sam · Operator/);
  assert.match(html, /Expires in 7d/);
  assert.match(html, /Revoke/);
  assert.doesNotMatch(html, /\/join#|textarea/);
});

test("public join shows inviter, suggested name and password manager fields", () => {
  const html = render(JoinView, { state: { kind: "ready", invite: checked }, onRetry: noop, onAccept: noop, onInvalid: noop });
  assert.match(html, /Join Crane/);
  assert.match(html, /Robin invited you as an operator/);
  assert.match(html, /name="name"[^>]*value="Sam"/);
  assert.match(html, /autocomplete="username"/i);
  assert.equal(html.match(/autocomplete="new-password"/gi)?.length, 2);
  assert.match(html, /3–32 lowercase letters/);
  assert.match(html, />Join<\/button>/);
});

test("public reset offers only password fields and the target username", () => {
  const html = render(JoinView, { state: { kind: "ready", invite: { ...checked, kind: "reset", username: "sam" } },
    onRetry: noop, onAccept: noop, onInvalid: noop });
  assert.match(html, /Set a new password for sam/);
  assert.equal(html.match(/type="password"/g)?.length, 2);
  const username = html.match(/<input[^>]*name="username"[^>]*>/)?.[0] ?? "";
  assert.match(username, /hidden=""/);
  assert.match(username, /value="sam"/);
  assert.doesNotMatch(html, /invited you|name="name"|3–32/);
  assert.match(html, />Set password<\/button>/);
});

test("invalid, expired or used links show no form; a rate limit says when and offers a retry", () => {
  const props = { onRetry: noop, onAccept: noop, onInvalid: noop };
  const invalid = render(JoinView, { ...props, state: { kind: "error", invalid: true, message: INVALID_LINK } });
  assert.match(invalid, /This link has expired or was already used. Ask an admin for a new one./);
  assert.doesNotMatch(invalid, /<form|<input|Try again/);
  const limited = render(JoinView, { ...props, state: { kind: "error", ...linkFailure({ status: 429, body: { retryAfterSeconds: 300 } }) } });
  assert.match(limited, /Try again in 5 minutes/);
  assert.match(limited, />Try again<\/button>/);
  assert.doesNotMatch(limited, /<form|<input/);
});
