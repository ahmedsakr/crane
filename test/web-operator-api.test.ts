import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthStatus, EventActor, InviteCheck, InviteSummary, OperatorRole, OperatorSummary } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";

type Issued = { invite: InviteSummary; path: string; token: string };
interface OperatorApi {
  signIn: (username: string, password: string) => Promise<AuthStatus>;
  session: () => Promise<AuthStatus>;
  operators: () => Promise<OperatorSummary[]>;
  invites: () => Promise<InviteSummary[]>;
  inviteOperator: (role: OperatorRole, name?: string) => Promise<Issued>;
  revokeInvite: (id: string) => Promise<InviteSummary[]>;
  setOperatorRole: (id: string, role: OperatorRole) => Promise<OperatorSummary[]>;
  resetOperatorPassword: (id: string) => Promise<Issued>;
  signOutOperator: (id: string) => Promise<OperatorSummary[]>;
  removeOperator: (id: string) => Promise<OperatorSummary[]>;
  checkInvite: (token: string) => Promise<InviteCheck>;
  acceptInvite: (token: string, input: { username?: string; name?: string; password: string }) => Promise<AuthStatus>;
}
// As in the other web tests, don't make NodeNext traverse web's extensionless imports.
const apiPath = new URL("../web/src/lib/api.ts", import.meta.url).href;
const { api } = await import(apiPath) as { api: OperatorApi };
const host: EventActor = { kind: "host", name: "Host" };
const password = "demo-password-123";

/** Real app.request() calls through the web client, with an in-memory cookie jar instead of sockets. */
async function setup() {
  const store = new Store(":memory:");
  const clock = { now: Date.now() };
  const actions = new OperatorActions(store, () => clock.now);
  const robin = await actions.addOperator(host, { username: "robin", name: "Robin", role: "admin", password });
  const app = createApp(store, { clock: () => clock.now, log: () => {}, clientKey: () => "web-test" });
  const client = { cookie: "" };
  const paths: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    paths.push(path);
    const headers = new Headers(init?.headers);
    if (client.cookie) headers.set("cookie", client.cookie);
    const res = await app.request(path, { ...init, headers });
    const cookie = res.headers.get("set-cookie");
    if (cookie) client.cookie = cookie.split(";")[0]!;
    return res;
  };
  return { store, robin, clock, client, paths, close: () => { globalThis.fetch = original; store.close(); } };
}

test("web operator client: invite, anonymous join, roles, reset, revocation, sign-out and removal use the landed API", async () => {
  const fixture = await setup();
  const { robin, client, paths } = fixture;
  try {
    await api.signIn("robin", password);
    const adminCookie = client.cookie;
    const issued = await api.inviteOperator("operator", "Sam");
    assert.equal(issued.path, `/join#${issued.token}`);
    const list = await api.invites();
    assert.equal(list[0]?.id, issued.invite.id);
    assert.ok(list.every((i) => !("token" in i) && !("path" in i)), "the link can't be retrieved a second time");

    client.cookie = ""; // A fresh, anonymous device follows the link.
    const checked = await api.checkInvite(issued.token);
    assert.equal(checked.invitedBy, "Robin");
    assert.equal(checked.role, "operator");
    const joined = await api.acceptInvite(issued.token, { username: "sam", name: "Sam", password });
    assert.equal(joined.signedIn, true);
    assert.equal(joined.operator?.username, "sam");
    assert.match(client.cookie, /^crane_session=.+/);
    assert.equal((await api.session()).operator?.username, "sam");
    const sam = joined.operator!;
    const samCookie = client.cookie;
    await assert.rejects(api.checkInvite(issued.token), { status: 401 });
    assert.equal((await api.operators()).length, 2);
    await assert.rejects(api.invites(), { status: 403 });

    client.cookie = adminCookie;
    assert.equal((await api.setOperatorRole(sam.id, "admin")).find((o) => o.id === sam.id)?.role, "admin");
    assert.equal((await api.setOperatorRole(sam.id, "operator")).find((o) => o.id === sam.id)?.role, "operator");
    await assert.rejects(api.setOperatorRole(robin.id, "operator"), { message: "Keep at least one admin", status: 400 });
    await assert.rejects(api.removeOperator(robin.id), { message: "Keep at least one admin", status: 400 });
    const reset = await api.resetOperatorPassword(sam.id);
    client.cookie = "";
    assert.equal((await api.checkInvite(reset.token)).username, "sam");
    const resetStatus = await api.acceptInvite(reset.token, { password: "a completely new password" });
    assert.equal(resetStatus.operator?.id, sam.id);
    assert.equal(resetStatus.signedIn, true);
    const resetCookie = client.cookie;
    client.cookie = samCookie;
    assert.equal((await api.session()).signedIn, false, "reset revoked the old devices");

    client.cookie = adminCookie;
    assert.equal((await api.signOutOperator(sam.id)).find((o) => o.id === sam.id)?.devices, 0);
    client.cookie = resetCookie;
    assert.equal((await api.session()).signedIn, false);
    client.cookie = adminCookie;
    assert.ok(!(await api.removeOperator(sam.id)).some((o) => o.id === sam.id));
    const revoked = await api.inviteOperator("admin");
    assert.deepEqual(await api.revokeInvite(revoked.invite.id), []);
    client.cookie = "";
    await assert.rejects(api.checkInvite(revoked.token), { status: 401 });
    for (const secret of [issued.token, reset.token, revoked.token]) {
      assert.ok(paths.every((p) => !p.includes(secret)), "tokens never travel in a path or query");
    }
  } finally { fixture.close(); }
});

test("web operator client: expired invites and resets give the public page the same invalid-link refusal", async () => {
  const fixture = await setup();
  try {
    await api.signIn("robin", password);
    const join = await api.inviteOperator("operator");
    const reset = await api.resetOperatorPassword(fixture.robin.id);
    fixture.client.cookie = "";
    fixture.clock.now += 8 * 86_400_000;
    for (const issued of [join, reset]) {
      await assert.rejects(api.checkInvite(issued.token), { status: 401, message: "This link has expired or was already used" });
      await assert.rejects(api.acceptInvite(issued.token, { username: "new", name: "New", password }), { status: 401 });
    }
  } finally { fixture.close(); }
});
