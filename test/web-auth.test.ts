import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthStatus, OperatorProfile, OperatorSession } from "@crane/contracts";
import {
  SignedOutError,
  createAuthStore,
  initialOf,
  isSignInRefusal,
  isSignedOut,
  needsSignIn,
  onSignInRequired,
  retryAfterText,
  signInFailure,
  withoutSession,
} from "../web/src/lib/auth.ts";
import { runAction } from "../web/src/lib/action.ts";

// tsx applies the root tsconfig only inside `src`, so web's .tsx files compile to React.createElement here.
Object.assign(globalThis, { React });
// By computed path: these import web modules without extensions, which only web's own tsconfig accepts.
const webModule = <T>(path: string): Promise<T> => import(new URL(`../web/src/${path}`, import.meta.url).href);
type ApiErrorLike = Error & { status: number; body: unknown };
const { ApiError, responseError } = await webModule<{
  ApiError: new (message: string, status: number, body: unknown) => ApiErrorLike;
  responseError: (status: number, body: unknown) => Error;
}>("lib/api.ts");
const { SignIn } = await webModule<{ SignIn: ComponentType<never> }>("pages/SignIn.tsx");
const { AccountMenuList } = await webModule<{ AccountMenuList: ComponentType<never> }>("components/shell/AccountMenu.tsx");

const operator: OperatorProfile = { id: "o-1", username: "robin", name: "Robin Park", role: "admin", createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: null };
const session: OperatorSession = {
  id: "s-1", operatorId: "o-1", current: true, createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z", client: "Chrome on Linux",
};
const signedIn: AuthStatus = { required: true, signedIn: true, setUp: true, operator, session };
const signedOut: AuthStatus = { required: true, signedIn: false, setUp: true, operator: null, session: null };
const open: AuthStatus = { required: false, signedIn: false, setUp: false, operator: null, session: null };

const render = (component: ComponentType<never>, props: object) => renderToStaticMarkup(h(component, props as never));

test("web auth: only the gate's 401 with signIn: true counts as signed out", () => {
  assert.equal(isSignInRefusal(401, { error: "Sign in to continue", signIn: true }), true);
  // A wrong password on the sign-in form is a 401 too, but it's the form's to show.
  assert.equal(isSignInRefusal(401, { error: "That username or password isn't right" }), false);
  assert.equal(isSignInRefusal(403, { error: "Only admins can manage operators", signIn: true }), false);
  assert.equal(isSignInRefusal(401, null), false);
  assert.equal(isSignInRefusal(401, "signIn"), false);
});

test("web auth: a refused call raises the signal and throws SignedOutError; others keep status and body", () => {
  let raised = 0;
  const stop = onSignInRequired(() => raised++);
  try {
    const refused = responseError(401, { error: "Sign in to continue", signIn: true });
    assert.ok(refused instanceof SignedOutError && isSignedOut(refused));
    assert.equal(refused.message, "Sign in to continue");
    assert.equal(raised, 1);

    const limited = responseError(429, { error: "Too many failed attempts. Try again in 5 minutes.", retryAfterSeconds: 300 });
    assert.ok(limited instanceof ApiError && !isSignedOut(limited));
    assert.equal((limited as ApiErrorLike).status, 429);
    assert.deepEqual((limited as ApiErrorLike).body,{ error: "Too many failed attempts. Try again in 5 minutes.", retryAfterSeconds: 300 });
    assert.equal(responseError(500, {}).message, "Request failed (500)");
    assert.equal(raised, 1);
  } finally {
    stop();
  }
  responseError(401, { signIn: true });
  assert.equal(raised, 1, "a removed listener hears nothing");
});

test("web auth: a rate limit says when to try again, rounded up", () => {
  assert.equal(retryAfterText(1), "Too many attempts. Try again in 1 second.");
  assert.equal(retryAfterText(0), "Too many attempts. Try again in 1 second.");
  assert.equal(retryAfterText(42.2), "Too many attempts. Try again in 43 seconds.");
  assert.equal(retryAfterText(60), "Too many attempts. Try again in 1 minute.");
  assert.equal(retryAfterText(61), "Too many attempts. Try again in 2 minutes.");
  assert.equal(retryAfterText(900), "Too many attempts. Try again in 15 minutes.");
});

test("web auth: a failed sign-in shows the wait when limited, else the server's words", () => {
  assert.equal(signInFailure(new ApiError("Too many failed attempts.", 429, { retryAfterSeconds: 120 })), "Too many attempts. Try again in 2 minutes.");
  assert.equal(signInFailure(new ApiError("That username or password isn't right", 401, { error: "That username or password isn't right" })),
    "That username or password isn't right");
  assert.equal(signInFailure(new TypeError("Failed to fetch")), "Failed to fetch");
  assert.equal(signInFailure("nope"), "Sign-in didn't work. Try again.");
});

test("web auth: sign-in shows only when required and missing", () => {
  assert.equal(needsSignIn(signedIn), false);
  assert.equal(needsSignIn(signedOut), true);
  assert.equal(needsSignIn(open), false, "loopback with no operators opens as it always did");
  assert.equal(needsSignIn({ ...open, required: true }), true, "an exposed factory with no operators shows the setup line");
  assert.deepEqual(withoutSession(signedIn), signedOut);
});

test("web auth: an action refused for want of a session doesn't toast; other failures still do", async () => {
  const toasts: string[] = [];
  const effects = { setBusy: () => {}, toast: (t: { text: string }) => void toasts.push(t.text) };
  await runAction(effects, { key: "approve", action: () => Promise.reject(new SignedOutError("Sign in to continue")) });
  assert.deepEqual(toasts, []);
  await runAction(effects, { key: "approve", action: () => Promise.reject(new Error("Already approved")) });
  assert.deepEqual(toasts, ["Already approved"]);
});

test("web auth: the account button shows one capital letter", () => {
  assert.equal(initialOf("Robin Park", "robin"), "R");
  assert.equal(initialOf("  ", "sam.k"), "S");
  assert.equal(initialOf("élodie", "e"), "É");
  assert.equal(initialOf("", ""), "?");
});

function fakeCalls(answers: AuthStatus[]) {
  const calls = { session: 0, signOut: 0 };
  let release: () => void = () => {};
  const gate = () => new Promise<void>((r) => (release = r));
  return {
    calls,
    release: () => release(),
    api: {
      session: async () => {
        calls.session++;
        await gate();
        return answers.shift() ?? signedOut;
      },
      signOut: async () => {
        calls.signOut++;
        return signedOut;
      },
    },
  };
}

test("web auth: a refusal mid-session signs out at once and asks the server once, however many polls fail", async () => {
  const fake = fakeCalls([signedOut]);
  const store = createAuthStore(fake.api);
  store.set(signedIn);
  let renders = 0;
  store.subscribe(() => renders++);
  store.refused();
  assert.deepEqual(store.get().status, signedOut, "every page stops on the next render");
  store.refused();
  store.refused();
  assert.equal(fake.calls.session, 1);
  assert.equal(renders, 1);
  fake.release();
  await store.refresh();
  assert.deepEqual(store.get(), { status: signedOut, error: null });
});

test("web auth: concurrent checks share one request, and a failed first check keeps the error", async () => {
  const fake = fakeCalls([signedIn]);
  const store = createAuthStore(fake.api);
  const first = store.refresh();
  assert.equal(store.refresh(), first);
  fake.release();
  await first;
  assert.equal(fake.calls.session, 1);
  assert.equal(store.get().status?.operator?.username, "robin");

  const down = createAuthStore({ session: () => Promise.reject(new TypeError("Failed to fetch")), signOut: fake.api.signOut });
  await down.refresh();
  assert.deepEqual(down.get(), { status: null, error: "Failed to fetch" });
});

test("web auth: signing out publishes the server's signed-out status", async () => {
  const fake = fakeCalls([]);
  const store = createAuthStore(fake.api);
  store.set(signedIn);
  await store.signOut();
  assert.equal(fake.calls.signOut, 1);
  assert.deepEqual(store.get().status, signedOut);
});

test("web auth: the sign-in screen has the form and invite line, or the setup line and no form", () => {
  const form = render(SignIn, { status: signedOut, onSignedIn: () => {} });
  assert.match(form, /Sign in to Crane/);
  assert.match(form, /autoComplete="username"|autocomplete="username"/);
  assert.match(form, /autoComplete="current-password"|autocomplete="current-password"/);
  assert.match(form, /<button[^>]*type="submit"[^>]*>Sign in<\/button>/);
  assert.match(form, /New here\? Ask an admin for an invite link\./);

  const setup = render(SignIn, { status: { ...open, required: true }, onSignedIn: () => {} });
  assert.match(setup, /Sign-in isn&#x27;t set up\. On the host, run <code[^>]*>crane operators add &lt;username&gt; --admin<\/code>\./);
  assert.doesNotMatch(setup, /<form|<input/);
});

test("web auth: the account menu names the operator and role, then lists its entries", () => {
  const html = render(AccountMenuList, { operator, items: [{ key: "sign-out", label: "Sign out", onSelect: () => {} }], onPick: () => {} });
  assert.match(html, /<strong>Robin Park<\/strong>/);
  assert.match(html, /Admin · <span class="mono">robin<\/span>/);
  assert.match(html, /role="menuitem"[^>]*>Sign out<\/button>/);
});
