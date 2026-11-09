import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventActor } from "@crane/contracts";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { serve, type ServeOptions } from "../src/cli/serve.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

class Exit extends Error {}

const HOST: EventActor = { kind: "host", name: "ahmed" };
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A port something else already holds, so a serve that gets as far as listening stops there instead of running. */
async function takenPort() {
  const taken = createServer();
  await new Promise<void>((listening) => taken.listen(0, "127.0.0.1", listening));
  const { port } = taken.address() as AddressInfo;
  return { port, close: () => new Promise((closed) => taken.close(closed)) };
}

/** A store with one queued task, and optionally the admin Sam. */
async function factoryStore(opts: { operator?: boolean } = {}) {
  const store = new Store(":memory:");
  const repo = store.addRepo({ path: "/repo" });
  const task = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: repo.id, autonomy: "observe" });
  if (opts.operator) {
    await new OperatorActions(store).addOperator(HOST, { username: "sam", name: "Sam", role: "admin", password: "correct horse battery" });
  }
  return { store, task };
}

/** Run `serve` until it exits, with what it printed. Every case here exits before the factory starts. */
async function serveUntilExit(store: Store, opts: Partial<ServeOptions> & { port: number }) {
  const errors: string[] = [];
  const logs: string[] = [];
  const { error, log } = console;
  const exit = process.exit;
  console.error = (...args: unknown[]) => void errors.push(plain(args.join(" ")));
  console.log = (...args: unknown[]) => void logs.push(plain(args.join(" ")));
  process.exit = ((code?: number) => {
    throw new Exit(`exit ${code}`);
  }) as typeof process.exit;
  try {
    await assert.rejects(serve(store, { agents: 1, driver: "simulated", buildDashboard: false, ...opts }), Exit);
  } finally {
    console.error = error;
    console.log = log;
    process.exit = exit;
  }
  return { errors: errors.join("\n"), logs: logs.join("\n") };
}

test("serve: a port in use says so, before the factory takes any work", async () => {
  const taken = await takenPort();
  const { store, task } = await factoryStore();
  try {
    const { errors } = await serveUntilExit(store, { port: taken.port, host: "127.0.0.1" });
    assert.match(errors, new RegExp(`Port ${taken.port} is already in use`));
    assert.equal(store.getTask(task.id)?.status, "queued", "nothing was claimed for a factory that can't start");
  } finally {
    store.close();
    await taken.close();
  }
});

test("serve: exposed with no operators refuses to start, naming crane operators add", async () => {
  const taken = await takenPort();
  const { store, task } = await factoryStore();
  try {
    for (const opts of [{ host: "0.0.0.0" }, { host: "127.0.0.1", publicUrl: "https://crane.example.com" }]) {
      const { errors } = await serveUntilExit(store, { port: taken.port, ...opts });
      assert.match(errors, /crane operators add <username> --admin/, JSON.stringify(opts));
      assert.doesNotMatch(errors, /already in use/, "it stops before taking the port");
    }
    assert.equal(store.getTask(task.id)?.status, "queued");
    assert.equal(store.publicUrl(), null, "nothing is saved for a factory that didn't start");
  } finally {
    store.close();
    await taken.close();
  }
});

test("serve: exposed without an https public URL refuses to start unless --allow-insecure-http", async () => {
  const taken = await takenPort();
  const { store, task } = await factoryStore({ operator: true });
  try {
    for (const opts of [{ host: "0.0.0.0" }, { host: "127.0.0.1", publicUrl: "http://crane.example.com" }]) {
      const { errors } = await serveUntilExit(store, { port: taken.port, ...opts });
      assert.match(errors, /without an https --public-url/, JSON.stringify(opts));
      assert.match(errors, /--allow-insecure-http/);
      assert.doesNotMatch(errors, /already in use/);
    }
    // With the override it goes on to listen, here onto a taken port, after warning.
    const allowed = await serveUntilExit(store, { port: taken.port, host: "0.0.0.0", allowInsecureHttp: true });
    assert.match(allowed.logs, /! Exposed without an https --public-url.*Serving anyway, because of --allow-insecure-http/);
    assert.match(allowed.errors, /already in use/);
    assert.equal(store.getTask(task.id)?.status, "queued");
  } finally {
    store.close();
    await taken.close();
  }
});

test("serve: an invalid public URL, or one with a path, refuses to start", async () => {
  const taken = await takenPort();
  const { store } = await factoryStore({ operator: true });
  try {
    const cases: [string, RegExp][] = [
      ["crane.example.com", /takes the address operators browse to/],
      ["ftp://crane.example.com", /must start with https:\/\//],
      ["https://crane.example.com/crane", /without a path.*https:\/\/crane\.example\.com/],
      ["https://crane.example.com/?next=1", /without a path/],
      ["https://sam:pw@crane.example.com", /username or password/],
    ];
    for (const [publicUrl, message] of cases) {
      const { errors } = await serveUntilExit(store, { port: taken.port, publicUrl });
      assert.match(errors, message, publicUrl);
      assert.doesNotMatch(errors, /already in use/);
    }
  } finally {
    store.close();
    await taken.close();
  }
});

test("serve: an https public URL with an operator gets as far as listening", async () => {
  const taken = await takenPort();
  const { store } = await factoryStore({ operator: true });
  try {
    store.setPublicUrl("https://old.example.com");
    const { errors, logs } = await serveUntilExit(store, { port: taken.port, publicUrl: "https://crane.example.com/", trustProxy: true });
    assert.match(errors, /already in use/);
    assert.doesNotMatch(logs, /Serving anyway/);
    assert.equal(store.publicUrl(), "https://old.example.com", "the setting changes only once serving starts");
  } finally {
    store.close();
    await taken.close();
  }
});
