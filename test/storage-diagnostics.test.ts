import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { StorageDiagnostics, storageSnapshot } from "../packages/factory/src/storage-diagnostics.js";
import { temporaryRoot } from "./support/fixtures.js";

test("storage diagnostics retain early split errors independently of noisy output", async t => {
  const root = temporaryRoot(t, "crane-storage-");
  const diagnostics = new StorageDiagnostics(root);
  diagnostics.collect("stderr", "write failed: ENOS");
  diagnostics.collect("stdout", "ordinary interleaved output\n");
  diagnostics.collect("stderr", "PC: no space left on device\n");
  diagnostics.collect("stdout", "x".repeat(2 * 1024 * 1024) + "\n");
  diagnostics.collect("stderr", "SQLITE_FULL: database or disk is full");
  const result = await diagnostics.finish();
  assert.match(result, /\[stderr\] write failed: ENOSPC/);
  assert.match(result, /\[stderr\] SQLITE_FULL/);
  assert.match(result, /availableBytes=\d+ freeBytes=\d+ totalBytes=\d+ freeInodes=\d+ totalInodes=\d+/);
  assert.ok(result.length < 16_384);
});

test("storage evidence is bounded and redacted; ordinary failures collect no snapshot", async t => {
  const root = temporaryRoot(t, "crane-storage-");
  const ordinary = new StorageDiagnostics(root);
  ordinary.collect("stderr", "assertion failed\n");
  assert.equal(await ordinary.finish(), "");
  const diagnostics = new StorageDiagnostics(root);
  for (let i = 0; i < 100; i++) diagnostics.collect("stderr", `ENOSPC TOKEN=secret-${i}\n`);
  const result = await diagnostics.finish();
  assert.equal((result.match(/\[stderr\]/g) ?? []).length, 4);
  assert.ok(!result.includes("secret-"));
  assert.ok(result.length < 16_384);
});

test("unavailable storage paths are reported without failing the check", async t => {
  const root = temporaryRoot(t, "crane-storage-");
  const snapshot = await storageSnapshot(`${root}/absent`);
  assert.match(snapshot, /absent: unavailable \(ENOENT\)/);
});
