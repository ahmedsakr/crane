import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { serve } from "../src/cli/serve.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

class Exit extends Error {}

test("serve: a port in use says so, before the factory takes any work", async () => {
  const taken = createServer();
  await new Promise<void>((listening) => taken.listen(0, "127.0.0.1", listening));
  const { port } = taken.address() as AddressInfo;

  const store = new Store(":memory:");
  const repo = store.addRepo({ path: "/repo" });
  const task = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: repo.id, autonomy: "observe" });

  const errors: string[] = [];
  const { error } = console;
  const exit = process.exit;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  process.exit = ((code?: number) => {
    throw new Exit(`exit ${code}`);
  }) as typeof process.exit;
  try {
    await assert.rejects(serve(store, { port, host: "127.0.0.1", agents: 1, driver: "simulated", buildDashboard: false }), Exit);
    assert.match(errors.join("\n"), new RegExp(`Port ${port} is already in use`));
    assert.equal(store.getTask(task.id)?.status, "queued", "nothing was claimed for a factory that can't start");
  } finally {
    console.error = error;
    process.exit = exit;
    store.close();
    await new Promise((closed) => taken.close(closed));
  }
});
