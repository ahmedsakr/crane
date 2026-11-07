import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { serve } from "@hono/node-server";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { Store } from "../../src/core/store.js";
import { dbPath, craneHome } from "../../src/core/paths.js";
import { runCli } from "../../src/cli/program.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import { cookieFrom, type App, type Call } from "./api-client.js";
import { onFixtureCleanup, temporaryRoot, testHome } from "./fixtures.js";
import { sh } from "./git.js";

export const PUBLIC_URL = "https://crane.example.test";
export const PASSWORD = "robin-e2e-password-2026";
export const KAI_PASSWORD = "kai-e2e-password-2026";
export const WRONG_PASSWORD = "wrong-e2e-password-2026";

/** Capture CLI output without a subprocess; commands still open a separate connection to the real home. */
export async function hostCommand(log: string[], args: string[], stdin = ""): Promise<void> {
  const store = new Store(dbPath());
  const original = console.log;
  console.log = (...items: unknown[]) => { log.push(items.join(" ")); };
  try {
    await runCli(["node", "crane", ...args], store, { readLine: async () => stdin });
  } finally {
    console.log = original;
    store.close();
  }
}

/** The same Node adapter, bind address and app options as serve(), with an ephemeral port and no scheduler. */
export async function listen(t: TestContext, app: App): Promise<string> {
  let server: Server;
  const ready = new Promise<string>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${port}`);
    }) as Server;
    server.once("error", reject);
  });
  onFixtureCleanup(t, async () => {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  return ready;
}

/** Simulate an HTTPS reverse proxy over its real loopback connection, keeping the browser's Host and Origin. */
export function proxyClient(base: string) {
  return (method: string, path: string, opts: Call = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      host: new URL(PUBLIC_URL).host,
      origin: PUBLIC_URL,
      "x-forwarded-proto": "https",
      "x-forwarded-for": opts.client ?? "198.51.100.10",
      "content-type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
    signal: AbortSignal.timeout(10_000),
  });
}

export async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const body = await response.json() as T;
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

export async function secureCookie(response: Response): Promise<string> {
  assert.equal(response.status, 200, await response.clone().text());
  const attributes = response.headers.get("set-cookie")!.split("; ");
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) assert.ok(attributes.includes(attribute), attribute);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  await response.text();
  return cookieFrom(response);
}

/** A real candidate worktree keeps approve awaiting git cleanup while the conflicting HTTP request arrives. */
export function reviewTask(t: TestContext, store: Store) {
  const root = temporaryRoot(t, "crane-auth-repo-");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "notes.md"), "Review this candidate\n");
  sh(checkout, "add", "notes.md");
  sh(checkout, "commit", "-q", "-m", "initial");
  const worktree = join(root, "worktree");
  sh(checkout, "worktree", "add", "-q", "-b", "crane/auth-e2e", worktree);
  const repo = store.addRepo({ path: checkout });
  const task = store.createTask({ kind: "maintenance", title: "Review together", brief: "", repoId: repo.id, autonomy: "propose" });
  store.updateTask(task.id, { status: "needs_review", branch: "crane/auth-e2e", worktree,
    visualReview: { status: "not_required", commit: "a".repeat(40), tree: "b".repeat(40), note: "Backend fixture", decidedAt: null } });
  return task;
}

/** A real retained PNG attachment, so a 200 response must contain image bytes rather than the SPA fallback. */
export function attachScreenshot(store: Store, taskId: string) {
  const name = "00000000-0000-4000-8000-000000000001.png";
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
  const dir = join(craneHome(), "attachments", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
  store.updateTask(taskId, { report: { summary: "Auth fixture", findings: [], changedFiles: [], screenshots: [{ path: name, caption: "Fixture" }] } });
  return { name, bytes };
}

/** Check raw database, WAL, SHM and every other file, including deleted records still present in SQLite pages. */
export function assertSecretFree(log: string[], secrets: string[], root = craneHome()): void {
  for (const secret of secrets) assert.ok(!log.join("\n").includes(secret), "a secret reached CLI/server output");
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) assertSecretFree([], secrets, path);
    else {
      assert.ok(entry.isFile(), `unexpected non-file in temporary home: ${path}`);
      const bytes = readFileSync(path);
      for (const secret of secrets) assert.ok(!bytes.includes(Buffer.from(secret)), `a secret reached ${path}`);
    }
  }
}

export async function setup(t: TestContext, options: AppOptions = {}, admin = false) {
  testHome(t);
  const store = new Store(dbPath());
  onFixtureCleanup(t, () => store.close());
  const log: string[] = [];
  if (admin) await hostCommand(log, ["operators", "add", "robin", "--name", "Robin", "--admin", "--password-stdin"], PASSWORD);
  const app = createApp(store, { ...options, log: (line) => log.push(line) });
  const base = await listen(t, app);
  return { store, log, app, base, send: proxyClient(base) };
}
