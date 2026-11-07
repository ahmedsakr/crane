import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { actorLabel, describeClient, normalizeUsername, type EventActor } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { currentActor, withActor } from "../src/core/actor.js";
import { AccessError, OperatorActions } from "../src/factory/actions.js";
import { dummyVerify, hashPassword, newToken, tokenDigest, verifyPassword } from "../src/factory/auth-crypto.js";

const HOST: EventActor = { kind: "host", name: "ahmed" };
const ADMIN_PASSWORD = "correct horse battery";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** An in-memory factory whose clock the test moves, with one admin added on the host. */
async function setup() {
  const store = new Store(":memory:");
  const clock = { now: Date.parse("2026-11-01T12:00:00.000Z") };
  const actions = new OperatorActions(store, () => clock.now);
  const admin = await actions.addOperator(HOST, { username: "Sam", name: "Sam", role: "admin", password: ADMIN_PASSWORD });
  const asOperator = (p: { id: string; name: string }): EventActor => ({ kind: "operator", id: p.id, name: p.name });
  const later = (ms: number) => { clock.now += ms; };
  return { store, actions, admin, adminActor: asOperator(admin), asOperator, later };
}

/** Invite and accept an operator with the given role, returning their actor and session token. */
async function join(actions: OperatorActions, username: string, role: "admin" | "operator" = "operator") {
  const { token } = actions.inviteOperator(HOST, { role });
  const signed = await actions.acceptInvite(token, { username, name: username, password: `${username} password!!` }, { client: "Firefox on macOS" });
  const actor: EventActor = { kind: "operator", id: signed.operator.id, name: signed.operator.name };
  return { ...signed, actor, password: `${username} password!!` };
}

const lastSeen = (store: Store, id: string) =>
  (store.db.prepare("SELECT last_seen_at FROM sessions WHERE id = ?").get(id) as { last_seen_at: string }).last_seen_at;
const rows = (store: Store, table: string) => store.db.prepare(`SELECT * FROM ${table}`).all();

test("access: passwords hash with a salt and verify only the same password", async () => {
  const hash = await hashPassword("a long enough password");
  const parsed = JSON.parse(hash);
  assert.deepEqual([parsed.algo, parsed.N, parsed.r, parsed.p], ["scrypt", 2 ** 15, 8, 1]);
  assert.equal(Buffer.from(parsed.salt, "base64").length, 16);
  assert.equal(Buffer.from(parsed.hash, "base64").length, 32);
  assert.equal(await verifyPassword("a long enough password", hash), true);
  assert.equal(await verifyPassword("a long enough passwore", hash), false);
  assert.notEqual(await hashPassword("a long enough password"), hash, "each hash has its own salt");
  for (const bad of ["", "not json", JSON.stringify({ ...parsed, N: 2 ** 30 }), JSON.stringify({ ...parsed, algo: "md5" })]) {
    assert.equal(await verifyPassword("a long enough password", bad), false, bad);
  }
  await dummyVerify();
});

test("access: tokens are random, URL-safe, and stored as SHA-256 digests", () => {
  const token = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newToken(), token);
  assert.match(tokenDigest(token), /^[0-9a-f]{64}$/);
  assert.equal(tokenDigest(token), tokenDigest(token));
});

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

test("access: adding an operator checks the username, name and password", async () => {
  const { actions } = await setup();
  const add = (input: Record<string, unknown>) =>
    actions.addOperator(HOST, { username: "alex", name: "Alex", role: "operator", password: "twelve chars", ...input });
  await assert.rejects(add({ username: "al" }), /Choose a username of 3 to 32/);
  await assert.rejects(add({ username: "-alex" }), /Choose a username/);
  await assert.rejects(add({ username: "alex smith" }), /Choose a username/);
  await assert.rejects(add({ name: "   " }), /Enter a name of 1 to 60 characters/);
  await assert.rejects(add({ name: "x".repeat(61) }), /Enter a name/);
  await assert.rejects(add({ name: "Alex\u001b[2J" }), /Enter a name/);
  await assert.rejects(add({ password: "eleven char" }), /Choose a password of at least 12 characters/);
  await assert.rejects(add({ role: "owner" }), /Choose the role admin or operator/);
  await assert.rejects(add({ username: "SAM" }), { message: "That username is taken" });
  const alex = await add({ username: " Alex " });
  assert.deepEqual([alex.username, alex.name, alex.role, alex.lastSeenAt], ["alex", "Alex", "operator", null]);
  assert.equal("passwordHash" in alex, false, "profiles never carry the hash");
});

test("access: the first operator must be an admin", async () => {
  const actions = new OperatorActions(new Store(":memory:"));
  await assert.rejects(actions.addOperator(HOST, { username: "alex", name: "Alex", role: "operator", password: "twelve chars" }),
    { message: "Make the first operator an admin" });
});

test("access: signIn says the same thing for an unknown username and a wrong password", async () => {
  const { actions } = await setup();
  const wrong = { name: "AccessError", status: 401, message: "That username or password isn't right" };
  await assert.rejects(actions.signIn("nobody", ADMIN_PASSWORD), wrong);
  await assert.rejects(actions.signIn("sam", "not the password"), wrong);
  await assert.rejects(actions.signIn(42, ADMIN_PASSWORD), wrong);
  await assert.rejects(actions.signIn("sam", undefined), wrong);
  const signed = await actions.signIn(" SAM ", ADMIN_PASSWORD, { client: "Chrome on Linux" });
  assert.equal(signed.operator.username, "sam");
  assert.deepEqual([signed.session.current, signed.session.client], [true, "Chrome on Linux"]);
  assert.equal(actions.authenticate(signed.token)?.operator.id, signed.operator.id);
  assert.equal(actions.authenticate("not a token"), null);
  assert.equal(actions.authenticate(undefined), null);
});

test("access: no plaintext password or token reaches the operators, sessions or invites tables", async () => {
  const { store, actions, admin } = await setup();
  const invite = actions.inviteOperator(HOST, { role: "operator", name: "Alex" });
  const joined = await actions.acceptInvite(invite.token, { username: "alex", password: "alex's secret pw" });
  const signed = await actions.signIn("sam", ADMIN_PASSWORD);
  const pending = actions.inviteOperator(HOST, { role: "admin" });
  const reset = actions.createPasswordReset(HOST, admin.id);
  const secrets = [ADMIN_PASSWORD, "alex's secret pw", invite.token, joined.token, signed.token, pending.token, reset.token];
  const dump = JSON.stringify(["operators", "sessions", "invites"].map((table) => rows(store, table)));
  for (const secret of secrets) assert.equal(dump.includes(secret), false, `${secret} is stored`);
  assert.ok(dump.includes(tokenDigest(signed.token)), "the session's digest is what is kept");
});

test("access: a session ends 30 days after sign-in however active, or after 7 idle days", async () => {
  const { actions, later } = await setup();
  const busy = await actions.signIn("sam", ADMIN_PASSWORD);
  const idle = await actions.signIn("sam", ADMIN_PASSWORD);
  later(7 * DAY - MINUTE);
  assert.ok(actions.authenticate(idle.token), "6 days 23:59 idle is still signed in");
  for (let day = 0; day < 23; day++) {
    assert.ok(actions.authenticate(busy.token), `day ${day}`);
    later(DAY);
  }
  assert.ok(actions.authenticate(busy.token), "a minute short of 30 days");
  later(MINUTE);
  assert.equal(actions.authenticate(busy.token), null, "30 days after sign-in");
  const quiet = await actions.signIn("sam", ADMIN_PASSWORD);
  later(7 * DAY);
  assert.equal(actions.authenticate(quiet.token), null, "7 days idle");
});

test("access: last_seen_at is written at most once every 5 minutes", async () => {
  const { store, actions, later } = await setup();
  const signed = await actions.signIn("sam", ADMIN_PASSWORD);
  const first = lastSeen(store, signed.session.id);
  later(MINUTE);
  assert.ok(actions.authenticate(signed.token));
  later(3 * MINUTE + 59_000);
  assert.ok(actions.authenticate(signed.token));
  assert.equal(lastSeen(store, signed.session.id), first, "no write within 5 minutes");
  later(1000);
  assert.equal(actions.authenticate(signed.token)?.session.lastSeenAt, new Date(Date.parse(first) + 5 * MINUTE).toISOString());
  assert.equal(lastSeen(store, signed.session.id), new Date(Date.parse(first) + 5 * MINUTE).toISOString());
  later(MINUTE);
  actions.authenticate(signed.token);
  assert.equal(lastSeen(store, signed.session.id), new Date(Date.parse(first) + 5 * MINUTE).toISOString());
  assert.equal(actions.listOperators()[0]?.lastSeenAt, lastSeen(store, signed.session.id));
});

test("access: a join link works once and expires after 7 days", async () => {
  const { actions, later } = await setup();
  const { invite, token } = actions.inviteOperator(HOST, { role: "operator", name: "Alex" });
  assert.deepEqual([invite.kind, invite.role, invite.name, invite.invitedBy, invite.forOperator], ["join", "operator", "Alex", "ahmed on the host", null]);
  assert.deepEqual(actions.listInvites(HOST).map((i) => i.id), [invite.id]);
  assert.deepEqual(actions.checkInvite(token), { kind: "join", role: "operator", name: "Alex", username: null, invitedBy: "ahmed on the host", expiresAt: invite.expiresAt });
  const signed = await actions.acceptInvite(token, { username: "alex", password: "alex password!" });
  assert.deepEqual([signed.operator.username, signed.operator.name, signed.operator.role], ["alex", "Alex", "operator"]);
  const used = { name: "AccessError", status: 401, message: "This link has expired or was already used" };
  assert.throws(() => actions.checkInvite(token), used);
  await assert.rejects(actions.acceptInvite(token, { username: "alex2", password: "alex password!" }), used);
  assert.deepEqual(actions.listInvites(HOST), []);
  const late = actions.inviteOperator(HOST, { role: "admin" });
  later(7 * DAY);
  assert.throws(() => actions.checkInvite(late.token), used);
  await assert.rejects(actions.acceptInvite(late.token, { username: "late", name: "Late", password: "late password!" }), used);
  assert.throws(() => actions.checkInvite("made up"), used);
  // Alex's session has also sat idle for those 7 days.
  assert.deepEqual(actions.pruneAccess(), { sessions: 1, invites: 2 });
});

test("access: an invite with a taken username stays usable", async () => {
  const { actions } = await setup();
  const { token } = actions.inviteOperator(HOST, { role: "operator" });
  await assert.rejects(actions.acceptInvite(token, { username: "sam", name: "Sam two", password: "twelve chars" }), { message: "That username is taken" });
  await assert.rejects(actions.acceptInvite(token, { username: "alex", password: "twelve chars" }), /Enter a name/);
  const signed = await actions.acceptInvite(token, { username: "alex", name: "Alex", password: "twelve chars" });
  assert.equal(signed.operator.username, "alex");
});

test("access: a reset link sets the password, signs out earlier devices, and lasts 24 hours", async () => {
  const { actions, admin, later } = await setup();
  const alex = await join(actions, "alex");
  const laptop = await actions.signIn("alex", alex.password);
  const first = actions.createPasswordReset(HOST, alex.operator.id);
  const { invite, token } = actions.createPasswordReset(HOST, alex.operator.id);
  assert.deepEqual(invite.forOperator, { id: alex.operator.id, username: "alex", name: "alex" });
  assert.deepEqual(actions.listInvites(HOST).map((i) => i.id), [invite.id], "a new reset replaces the old one");
  assert.throws(() => actions.checkInvite(first.token), { status: 401 });
  assert.equal(actions.checkInvite(token).username, "alex");
  const signed = await actions.acceptInvite(token, { username: "sam", password: "a brand new password" });
  assert.equal(signed.operator.id, alex.operator.id, "the username is ignored");
  assert.equal(actions.authenticate(alex.token), null);
  assert.equal(actions.authenticate(laptop.token), null);
  assert.ok(actions.authenticate(signed.token));
  await assert.rejects(actions.signIn("alex", alex.password), { status: 401 });
  assert.ok(await actions.signIn("alex", "a brand new password"));
  assert.ok(await actions.signIn("sam", ADMIN_PASSWORD), "other operators are untouched");
  const expiring = actions.createPasswordReset(HOST, admin.id);
  later(DAY);
  assert.throws(() => actions.checkInvite(expiring.token), { status: 401 });
});

test("access: admin actions refuse an operator with 403 and accept the host and admins", async () => {
  const { actions, adminActor, asOperator, store } = await setup();
  const alex = await join(actions, "alex");
  const forbidden = { name: "AccessError", status: 403, message: "Only admins can manage operators" };
  assert.throws(() => actions.inviteOperator(alex.actor, { role: "operator" }), forbidden);
  assert.throws(() => actions.listInvites(alex.actor), forbidden);
  assert.throws(() => actions.createPasswordReset(alex.actor, alex.operator.id), forbidden);
  assert.throws(() => actions.setOperatorRole(alex.actor, alex.operator.id, "admin"), forbidden);
  assert.throws(() => actions.removeOperator(alex.actor, alex.operator.id), forbidden);
  assert.throws(() => actions.signOutOperator(alex.actor, alex.operator.id), forbidden);
  assert.throws(() => actions.listAllSessions(alex.actor), forbidden);
  assert.throws(() => actions.signOutSessionById(alex.actor, alex.session.id), forbidden);
  assert.throws(() => actions.revokeInvite(alex.actor, "i-x"), forbidden);
  assert.throws(() => actions.inviteOperator({ kind: "operator", id: "o-gone", name: "Gone" }, { role: "operator" }), forbidden);
  const invite = actions.inviteOperator(adminActor, { role: "operator" });
  assert.equal(invite.invite.invitedBy, "Sam");
  actions.revokeInvite(HOST, invite.invite.id);
  assert.throws(() => actions.revokeInvite(HOST, invite.invite.id), /No pending link/);
  assert.equal(actions.setOperatorRole(HOST, alex.operator.id, "admin").role, "admin");
  assert.ok(actions.inviteOperator(asOperator(alex.operator), { role: "operator" }).token, "a promoted operator can invite");
  assert.equal(actions.listAllSessions(HOST).length, 1);
  assert.equal(actions.signOutOperator(adminActor, alex.operator.id), 1);
  assert.equal(rows(store, "sessions").length, 0);
});

test("access: host-only actions refuse operators, even admins", async () => {
  const { actions, adminActor, admin, store } = await setup();
  const hostOnly = { name: "AccessError", status: 403, message: "Do this on the host with crane" };
  await assert.rejects(actions.addOperator(adminActor, { username: "alex", name: "Alex", role: "operator", password: "twelve chars" }), hostOnly);
  await assert.rejects(actions.setOperatorPassword(adminActor, admin.id, "twelve chars"), hostOnly);
  assert.throws(() => actions.clearAccess(adminActor), hostOnly);
  const signed = await actions.signIn("sam", ADMIN_PASSWORD);
  await actions.setOperatorPassword(HOST, admin.id, "set on the host");
  assert.equal(actions.authenticate(signed.token), null, "setting a password signs that operator out");
  assert.ok(await actions.signIn("sam", "set on the host"));
  actions.inviteOperator(HOST, { role: "operator" });
  actions.clearAccess(HOST);
  for (const table of ["operators", "sessions", "invites"]) assert.deepEqual(rows(store, table), [], table);
  assert.deepEqual(actions.authStatus(undefined, { exposed: false }), { required: false, signedIn: false, setUp: false, operator: null, session: null });
});

test("access: the last admin can't be demoted or removed", async () => {
  const { actions, admin, store } = await setup();
  const alex = await join(actions, "alex");
  assert.throws(() => actions.setOperatorRole(HOST, admin.id, "operator"), { message: "Keep at least one admin" });
  assert.throws(() => actions.removeOperator(HOST, admin.id), { message: "Keep at least one admin" });
  actions.setOperatorRole(HOST, alex.operator.id, "admin");
  assert.equal(actions.setOperatorRole(HOST, admin.id, "operator").role, "operator");
  assert.throws(() => actions.removeOperator(HOST, alex.operator.id), { message: "Keep at least one admin" });
  actions.createPasswordReset(HOST, admin.id);
  await actions.signIn("sam", ADMIN_PASSWORD);
  actions.removeOperator(HOST, admin.id);
  assert.deepEqual(actions.listOperators().map((o) => o.username), ["alex"]);
  assert.equal(rows(store, "invites").filter((i) => (i as { operator_id: string | null }).operator_id === admin.id).length, 0, "invites cascade");
  assert.equal(rows(store, "sessions").length, 1, "only alex's session is left");
  assert.throws(() => actions.removeOperator(HOST, "o-none"), /No operator o-none/);
});

test("access: changing your password keeps this device and signs out the others", async () => {
  const { actions } = await setup();
  const alex = await join(actions, "alex");
  const phone = await actions.signIn("alex", alex.password);
  const sam = await actions.signIn("sam", ADMIN_PASSWORD);
  await assert.rejects(actions.changeMyPassword(alex.token, "not it at all", "a new password!"), { message: "Your current password isn't right" });
  await assert.rejects(actions.changeMyPassword(alex.token, alex.password, "short"), /at least 12 characters/);
  await assert.rejects(actions.changeMyPassword("bad token", alex.password, "a new password!"), { status: 401, message: "Sign in to continue" });
  await actions.changeMyPassword(alex.token, alex.password, "a new password!");
  assert.ok(actions.authenticate(alex.token), "this device stays");
  assert.equal(actions.authenticate(phone.token), null, "other devices go");
  assert.ok(actions.authenticate(sam.token), "other operators stay");
  assert.ok(await actions.signIn("alex", "a new password!"));
});

test("access: operators see and sign out only their own devices", async () => {
  const { actions } = await setup();
  const alex = await join(actions, "alex");
  const phone = await actions.signIn("alex", alex.password, { client: "Safari on iOS" });
  const sam = await actions.signIn("sam", ADMIN_PASSWORD);
  const mine = actions.listMySessions(alex.token);
  assert.deepEqual(mine.map((s) => [s.id, s.current]).sort(), [[alex.session.id, true], [phone.session.id, false]].sort());
  assert.throws(() => actions.signOutMySession(alex.token, sam.session.id), { message: "That device isn't signed in" });
  assert.equal(actions.listOperators().find((o) => o.username === "alex")?.devices, 2);
  actions.signOutMySession(alex.token, phone.session.id);
  assert.equal(actions.authenticate(phone.token), null);
  const tablet = await actions.signIn("alex", alex.password);
  assert.equal(actions.signOutMyOtherSessions(alex.token), 1);
  assert.equal(actions.authenticate(tablet.token), null);
  assert.equal(actions.renameMe(alex.token, "  Alex Kim ").name, "Alex Kim");
  actions.signOut(alex.token);
  assert.equal(actions.authenticate(alex.token), null);
  assert.throws(() => actions.listMySessions(alex.token), { status: 401 });
  assert.ok(actions.authenticate(sam.token));
});

test("access: sign-in is required once an operator exists or the factory is exposed", async () => {
  const empty = new OperatorActions(new Store(":memory:"));
  assert.equal(empty.authStatus(undefined, { exposed: false }).required, false);
  assert.equal(empty.authStatus(undefined, { exposed: true }).required, true);
  const { actions } = await setup();
  assert.deepEqual(actions.authStatus(undefined, { exposed: false }), { required: true, signedIn: false, setUp: true, operator: null, session: null });
  const signed = await actions.signIn("sam", ADMIN_PASSWORD);
  const status = actions.authStatus(signed.token, { exposed: true });
  assert.deepEqual([status.signedIn, status.operator?.username, status.session?.id], [true, "sam", signed.session.id]);
});

test("access: expired sessions and links are pruned", async () => {
  const { actions, later, store } = await setup();
  await actions.signIn("sam", ADMIN_PASSWORD);
  actions.inviteOperator(HOST, { role: "operator" });
  later(DAY);
  const fresh = await actions.signIn("sam", ADMIN_PASSWORD);
  later(6 * DAY + 1);
  assert.deepEqual(actions.pruneAccess(), { sessions: 1, invites: 1 });
  assert.deepEqual(rows(store, "sessions").map((s) => (s as { id: string }).id), [fresh.session.id]);
});

test("actor: currentActor follows withActor across awaits and is null outside", async () => {
  assert.equal(currentActor(), null);
  const sam: EventActor = { kind: "operator", id: "o-sam", name: "Sam" };
  assert.equal(withActor(HOST, () => currentActor()?.name), "ahmed");
  const seen = await withActor(sam, async () => {
    const before = currentActor();
    await sleep(5);
    const inner = await withActor(HOST, async () => { await sleep(1); return currentActor(); });
    await Promise.resolve();
    return [before, inner, currentActor()];
  });
  assert.deepEqual(seen, [sam, HOST, sam]);
  // Two requests at once each keep their own actor.
  const both = await Promise.all([sam, HOST].map((actor) => withActor(actor, async () => { await sleep(3); return currentActor(); })));
  assert.deepEqual(both, [sam, HOST]);
  assert.equal(currentActor(), null);
  assert.ok(new AccessError(429, "Slow down").status === 429);
});
