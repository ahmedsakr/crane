import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventActor } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp, type AppOptions } from "../src/server/app.js";
import { checkExposure, isLoopbackPeer, parsePublicUrl, withFrameAncestors } from "../src/server/security.js";

/**
 * Serving a factory others reach: through a public URL behind a reverse proxy, with or without trusting the proxy's
 * forwarded headers. Calls go through `app.request()`; a socket peer is faked through the Node bindings Hono reads.
 */

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

const HOST: EventActor = { kind: "host", name: "ahmed" };
const PASSWORD = "correct horse battery";
const PUBLIC = "https://crane.example.com";

type Send = { method?: string; headers?: Record<string, string>; body?: unknown; peer?: string; cookie?: string; encrypted?: boolean };

/** A factory with the admin Sam and a task waiting for review, served with `opts`. */
async function setup(opts: AppOptions = {}) {
  const store = new Store(":memory:");
  await new OperatorActions(store).addOperator(HOST, { username: "sam", name: "Sam", role: "admin", password: PASSWORD });
  const repo = store.addRepo({ path: "/repo" });
  const task = store.createTask({ kind: "maintenance", title: "Review me", brief: "", repoId: repo.id, autonomy: "propose" });
  store.updateTask(task.id, { status: "needs_review", branch: `crane/${task.id}`,
    visualReview: { status: "not_required", commit: "test", tree: "test", note: "No UI changes", decidedAt: null } });
  const log: string[] = [];
  const app = createApp(store, { log: (line) => log.push(line), ...opts });
  const send = (url: string, s: Send = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...s.headers };
    if (s.cookie) headers.cookie = s.cookie;
    const method = s.method ?? (s.body === undefined ? "GET" : "POST");
    const body = method === "GET" ? undefined : JSON.stringify(s.body ?? {});
    const env = { incoming: { socket: { remoteAddress: s.peer, encrypted: s.encrypted } } };
    return Promise.resolve(app.request(url, { method, headers, body }, env));
  };
  const signIn = (url: string, s: Send = {}) => send(url, { ...s, body: { username: "sam", password: s.body ?? PASSWORD } });
  return { store, task, log, send, signIn };
}

const setCookie = (res: Response) => res.headers.get("set-cookie") ?? assert.fail("no cookie set");
const pair = (res: Response) => setCookie(res).split(";")[0]!;

test("exposure: Crane's TLS socket makes cookies Secure and adds HSTS without proxy trust", async () => {
  const { store, signIn } = await setup();
  try {
    const res = await signIn("http://localhost:4471/api/auth/sign-in", {
      encrypted: true, peer: "127.0.0.1", headers: { "x-forwarded-proto": "http" },
    });
    assert.equal(res.status, 200);
    assert.match(setCookie(res), /; Secure/);
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
    const plain = await signIn("http://localhost:4471/api/auth/sign-in", { encrypted: false });
    assert.doesNotMatch(setCookie(plain), /; Secure/);
    assert.equal(plain.headers.get("strict-transport-security"), null);
  } finally { store.close(); }
});

test("exposure: with a public URL, only its Host and loopback are answered", async () => {
  const { store, send } = await setup({ publicUrl: PUBLIC });
  try {
    for (const url of [`${PUBLIC}/api/auth/session`, "http://crane.example.com/api/auth/session", "http://127.0.0.1:4471/api/auth/session"]) {
      assert.equal((await send(url)).status, 200, url);
    }
    for (const url of ["http://evil.example/api/auth/session", "http://203.0.113.9:4471/api/auth/session", "http://crane.example.com:8080/tasks"]) {
      const res = await send(url);
      assert.equal(res.status, 403, url);
      assert.match((await res.json()).error, /only answers at https:\/\/crane\.example\.com and on localhost/);
    }
    const status = await (await send(`${PUBLIC}/api/auth/session`)).json();
    assert.equal(status.required, true, "a public URL makes the factory exposed, so sign-in is always required");
  } finally { store.close(); }
});

test("exposure: with a public URL, writes from any other origin are refused with 403", async () => {
  const { store, task, send, signIn } = await setup({ publicUrl: PUBLIC });
  try {
    const signedIn = await signIn("http://crane.example.com/api/auth/sign-in", { headers: { origin: PUBLIC, "sec-fetch-site": "same-origin" } });
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    const cookie = pair(signedIn);
    const approve = (origin: string, host = "crane.example.com") => send(`http://${host}/api/tasks/${task.id}/approve`, {
      cookie, body: { merge: false }, headers: { origin },
    });
    for (const origin of ["https://evil.example", "http://crane.example.com", "https://crane.example.com:8443", "null", "http://localhost:5173"]) {
      const res = await approve(origin);
      assert.equal(res.status, 403, origin);
      assert.match((await res.json()).error, /Cross-origin requests can't change anything/);
    }
    const forged = await send(`http://crane.example.com/api/tasks/${task.id}/approve`, {
      cookie, body: { merge: false }, headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(forged.status, 403);
    assert.equal(store.getTask(task.id)?.status, "needs_review");

    // The Vite proxy keeps its loopback origin, which still counts as same-origin there.
    const local = await send(`http://localhost:5173/api/auth/sign-in`, { body: { username: "sam", password: PASSWORD }, headers: { origin: "http://localhost:5173" } });
    assert.equal(local.status, 200);
    assert.equal((await approve(PUBLIC)).status, 200);
    assert.equal(store.getTask(task.id)?.status, "approved");
  } finally { store.close(); }
});

test("exposure: the session cookie is Secure through an https public URL, and not on plain loopback", async () => {
  const { store, signIn } = await setup({ publicUrl: PUBLIC });
  try {
    // Behind a proxy that keeps the Host, the request reaches Crane as plain http, but the browser is on https.
    const proxied = await signIn("http://crane.example.com/api/auth/sign-in");
    assert.equal(proxied.status, 200);
    assert.match(setCookie(proxied), /; Secure/);
    assert.match(setCookie(proxied), /; HttpOnly/);
    assert.doesNotMatch(setCookie(await signIn("http://127.0.0.1:4471/api/auth/sign-in")), /Secure/);
  } finally { store.close(); }
});

test("exposure: with --trust-proxy, X-Forwarded-Proto from a loopback peer makes the cookie Secure", async () => {
  const { store, signIn } = await setup({ trustProxy: true });
  try {
    const https = { "x-forwarded-proto": "https" };
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.match(setCookie(await signIn("http://127.0.0.1:4471/api/auth/sign-in", { peer, headers: https })), /; Secure/, peer);
    }
    assert.doesNotMatch(setCookie(await signIn("http://127.0.0.1:4471/api/auth/sign-in", { peer: "127.0.0.1" })), /Secure/);
    const http = { "x-forwarded-proto": "http" };
    assert.doesNotMatch(setCookie(await signIn("http://127.0.0.1:4471/api/auth/sign-in", { peer: "127.0.0.1", headers: http })), /Secure/);
  } finally { store.close(); }
});

test("exposure: X-Forwarded-* from a non-loopback peer, or without --trust-proxy, is ignored", async () => {
  const forwarded = { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.7" };
  const trusting = await setup({ trustProxy: true, exposed: true });
  const untrusting = await setup({ exposed: true });
  try {
    const remote = await trusting.signIn("http://203.0.113.9:4471/api/auth/sign-in", { peer: "203.0.113.9", headers: forwarded });
    assert.doesNotMatch(setCookie(remote), /Secure/);
    assert.equal(remote.headers.get("strict-transport-security"), null);
    const local = await untrusting.signIn("http://127.0.0.1:4471/api/auth/sign-in", { peer: "127.0.0.1", headers: forwarded });
    assert.doesNotMatch(setCookie(local), /Secure/);

    // Sign-in limits count the socket, however each attempt varies its forwarded address.
    for (let i = 0; i < 5; i++) {
      const guess = await trusting.signIn("http://203.0.113.9:4471/api/auth/sign-in", {
        peer: "203.0.113.9", body: "wrong password!", headers: { "x-forwarded-for": `198.51.100.${i}` },
      });
      assert.equal(guess.status, 401);
    }
    const limited = await trusting.signIn("http://203.0.113.9:4471/api/auth/sign-in", {
      peer: "203.0.113.9", body: "wrong password!", headers: { "x-forwarded-for": "198.51.100.99" },
    });
    assert.equal(limited.status, 429);
    assert.ok(trusting.log.some((line) => /Sign-in failed for "sam" from 203\.0\.113\.9$/.test(line)), trusting.log.join("\n"));
    assert.ok(!trusting.log.some((line) => line.includes("198.51.100")), "forwarded addresses never become the client");
  } finally {
    trusting.store.close();
    untrusting.store.close();
  }
});

test("exposure: behind a trusted loopback proxy, sign-in limits count the last X-Forwarded-For hop", async () => {
  const { store, log, signIn } = await setup({ trustProxy: true });
  try {
    // A client can prepend anything; the proxy appends the address it saw.
    for (let i = 0; i < 6; i++) {
      const guess = await signIn("http://127.0.0.1:4471/api/auth/sign-in", {
        peer: "127.0.0.1", body: "wrong password!", headers: { "x-forwarded-for": `10.0.0.1, 198.51.100.${i}` },
      });
      assert.equal(guess.status, 401, `each client has its own limit: ${i}`);
    }
    assert.ok(log.some((line) => line.endsWith("from 198.51.100.5")), log.join("\n"));
    const v6 = await signIn("http://127.0.0.1:4471/api/auth/sign-in", {
      peer: "127.0.0.1", body: "wrong password!", headers: { "x-forwarded-for": "2001:db8:0:1::42" },
    });
    assert.equal(v6.status, 401);
    assert.ok(log.some((line) => line.endsWith("from 2001:db8:0:1::/64")), log.join("\n"));
  } finally { store.close(); }
});

test("exposure: every response carries the security headers, and HSTS only over https", async () => {
  const plain = await setup();
  const proxied = await setup({ publicUrl: PUBLIC });
  try {
    const expectHeaders = (res: Response, hsts: boolean, what: string) => {
      assert.equal(res.headers.get("x-frame-options"), "DENY", what);
      assert.match(res.headers.get("content-security-policy") ?? "", /(^|; )frame-ancestors 'none'$/, what);
      assert.equal(res.headers.get("referrer-policy"), "same-origin", what);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", what);
      assert.equal(res.headers.get("strict-transport-security"), hsts ? "max-age=31536000" : null, what);
    };
    const paths = ["/api/auth/session", "/api/overview", "/tasks", "/", "/assets/missing.js", "/api/nothing-here"];
    for (const path of paths) {
      expectHeaders(await plain.send(`http://127.0.0.1:4471${path}`), false, `loopback ${path}`);
      expectHeaders(await proxied.send(`http://crane.example.com${path}`), true, `public ${path}`);
      expectHeaders(await proxied.send(`http://127.0.0.1:4471${path}`), false, `public URL on loopback ${path}`);
    }
    // Refusals carry them too.
    expectHeaders(await plain.send("http://evil.example/api/overview"), false, "refused rebinding");
    expectHeaders(await proxied.send(`${PUBLIC}/api/overview`, { body: {}, headers: { origin: "https://evil.example" } }), true, "refused write");
    const trusted = await setup({ trustProxy: true });
    try {
      const over = (proto: string) => trusted.send("http://127.0.0.1:4471/", { peer: "127.0.0.1", headers: { "x-forwarded-proto": proto } });
      expectHeaders(await over("https"), true, "trusted https proxy");
      expectHeaders(await over("http"), false, "trusted http proxy");
    } finally { trusted.store.close(); }
  } finally {
    plain.store.close();
    proxied.store.close();
  }
});

test("exposure: frame-ancestors joins an existing policy without weakening it", () => {
  assert.equal(withFrameAncestors(null), "frame-ancestors 'none'");
  assert.equal(withFrameAncestors("default-src 'none'; sandbox"), "default-src 'none'; sandbox; frame-ancestors 'none'");
  assert.equal(withFrameAncestors("frame-ancestors *; img-src 'self';"), "img-src 'self'; frame-ancestors 'none'");
});

test("exposure: public URLs are origins, and loopback peers are this machine", () => {
  assert.equal(parsePublicUrl("https://Crane.Example.com/").origin, PUBLIC);
  assert.equal(parsePublicUrl("https://crane.example.com:8443").host, "crane.example.com:8443");
  for (const bad of ["crane.example.com", "ftp://x.example", "https://x.example/sub", "https://x.example/#a", "https://u:p@x.example"]) {
    assert.throws(() => parsePublicUrl(bad), Error, bad);
  }
  assert.throws(() => createApp(new Store(":memory:"), { publicUrl: "https://x.example/sub" }), /without a path/);
  for (const peer of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.ok(isLoopbackPeer(peer), peer);
  for (const peer of [null, "", "10.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "128.0.0.1"]) assert.ok(!isLoopbackPeer(peer), String(peer));
});

test("exposure: serving rules for each address", () => {
  const ok = { operators: 1 };
  assert.deepEqual(checkExposure({ host: "127.0.0.1", operators: 0 }), { exposed: false, publicUrl: null });
  assert.equal(checkExposure({ host: "::1", operators: 0 }).error, undefined);
  assert.match(checkExposure({ host: "0.0.0.0", operators: 0 }).error ?? "", /crane operators add <username> --admin/);
  assert.match(checkExposure({ host: "127.0.0.1", publicUrl: PUBLIC, operators: 0 }).error ?? "", /crane operators add/);
  assert.match(checkExposure({ host: "0.0.0.0", ...ok }).error ?? "", /without an https --public-url/);
  assert.match(checkExposure({ host: "127.0.0.1", publicUrl: "http://crane.example.com", ...ok }).error ?? "", /--allow-insecure-http/);
  const insecure = checkExposure({ host: "0.0.0.0", allowInsecureHttp: true, ...ok });
  assert.equal(insecure.error, undefined);
  assert.match(insecure.warning ?? "", /Serving anyway/);
  const https = checkExposure({ host: "127.0.0.1", publicUrl: `${PUBLIC}/`, ...ok });
  assert.deepEqual([https.exposed, https.publicUrl?.origin, https.error, https.warning], [true, PUBLIC, undefined, undefined]);
});
