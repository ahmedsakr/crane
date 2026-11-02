import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageImportViolations } from "./support/imports.ts";

const root = join(import.meta.dirname, "..", "packages", "worktree-deps");

test("worktree dependencies import only their implementation and Node modules", () => {
  const allowed = new Set([
    "node:child_process", "node:util", "node:fs", "node:fs/promises", "node:crypto", "node:path",
  ]);
  assert.deepEqual(packageImportViolations(join(root, "src"), (ref) => allowed.has(ref.spec!)), []);
});

test("the private dependency package exposes only installation", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(Object.keys(manifest[field] ?? {}), [], `no ${field}`);
  }
  const api = await import("@crane/worktree-deps");
  assert.deepEqual(Object.keys(api), ["installDependencies"]);
  for (const path of ["@crane/worktree-deps/src/deps.js", "@crane/worktree-deps/dist/deps.js", "@crane/worktree-deps/deps"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});
