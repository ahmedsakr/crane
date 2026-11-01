import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDependencies, installDependencies, npmInstallMatches } from "../src/factory/deps.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "crane-deps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", private: true, workspaces: ["packages/*"] }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "1.0.0", workspaces: ["packages/*"] } },
  }));
  git("add", ".");
  const addWorkspace = () => {
    mkdirSync(join(root, "packages", "contracts"), { recursive: true });
    writeFileSync(join(root, "packages", "contracts", "package.json"), JSON.stringify({ name: "@fixture/contracts", version: "1.0.0" }));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    lock.packages["packages/contracts"] = { name: "@fixture/contracts", version: "1.0.0" };
    lock.packages["node_modules/@fixture/contracts"] = { resolved: "packages/contracts", link: true };
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
    git("add", ".");
  };
  return { root, addWorkspace };
}

test("dependencies: refresh an already prepared tree when a workspace is introduced", async t => {
  const { root, addWorkspace } = fixture(t);
  assert.match((await installDependencies(root))!, /Installed dependencies/);
  addWorkspace();
  assert.match((await installDependencies(root))!, /Installed dependencies/);
  assert.equal(realpathSync(join(root, "node_modules/@fixture/contracts")), join(root, "packages/contracts"));
  assert.equal(await installDependencies(root), null, "unchanged inputs keep the fast path");
});

test("dependencies: manifests and workspace configuration invalidate preparation even without lock changes", async t => {
  const { root, addWorkspace } = fixture(t);
  addWorkspace();
  await installDependencies(root);
  for (const file of ["package.json", "packages/contracts/package.json", "pnpm-workspace.yaml"]) {
    const sentinel = join(root, "node_modules", "sentinel");
    writeFileSync(sentinel, "keep on the fast path");
    assert.equal(await installDependencies(root), null);
    assert.ok(existsSync(sentinel));
    if (file.endsWith(".json")) {
      const manifest = JSON.parse(readFileSync(join(root, file), "utf8"));
      manifest.description = "changed";
      writeFileSync(join(root, file), JSON.stringify(manifest));
    } else {
      writeFileSync(join(root, file), "packages:\n  - packages/*\n");
    }
    assert.match((await installDependencies(root))!, /Installed dependencies/, file);
    assert.ok(!existsSync(sentinel), "the clean install removed the old tree");
  }
});

test("dependencies: repair missing links and links into another checkout with unchanged inputs", async t => {
  const { root, addWorkspace } = fixture(t);
  const other = fixture(t);
  addWorkspace();
  other.addWorkspace();
  await installDependencies(root);
  const link = join(root, "node_modules/@fixture/contracts");
  for (const destination of [null, join(other.root, "packages/contracts")]) {
    rmSync(link);
    if (destination) symlinkSync(destination, link);
    assert.match((await installDependencies(root))!, /Installed dependencies/);
    assert.equal(realpathSync(link), join(root, "packages/contracts"));
    assert.ok(existsSync(join(other.root, "packages/contracts/package.json")), "the other checkout stays intact");
  }
});

test("dependencies: copied preparations are reusable and require matching manifests", async t => {
  const from = fixture(t);
  const to = fixture(t);
  from.addWorkspace();
  to.addWorkspace();
  await installDependencies(from.root);
  assert.deepEqual(await copyDependencies(from.root, to.root), ["node_modules"]);
  assert.equal(realpathSync(join(to.root, "node_modules/@fixture/contracts")), join(to.root, "packages/contracts"));
  assert.equal(await installDependencies(to.root, { from: from.root }), null);

  const stale = fixture(t);
  stale.addWorkspace();
  writeFileSync(join(stale.root, "packages/contracts/package.json"), '{"name":"@fixture/renamed","version":"1.0.0"}');
  assert.equal(await copyDependencies(from.root, stale.root), null, "identical locks cannot hide different workspace manifests");

  const updated = fixture(t);
  updated.addWorkspace();
  for (const root of [from.root, updated.root]) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.description = "changed since preparation";
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  }
  assert.equal(await copyDependencies(from.root, updated.root), null, "a source preparation with stale inputs cannot be reused");
});

test("dependencies: npm install records must match workspace link destinations", () => {
  const lock = { packages: { "node_modules/workspace": { link: true, resolved: "packages/workspace" } } };
  assert.ok(npmInstallMatches(lock, lock));
  assert.ok(!npmInstallMatches(lock, { packages: { "node_modules/workspace": { link: true, resolved: "old/path" } } }));
  assert.ok(!npmInstallMatches({ packages: {} }, { packages: { "node_modules/extra": { link: true } } }));
});

test("dependencies: refuse to refresh a node_modules directory linked to another checkout", async t => {
  const from = fixture(t);
  const to = fixture(t);
  mkdirSync(join(from.root, "node_modules"));
  const marker = join(from.root, "node_modules/.crane-dependencies");
  writeFileSync(marker, "operator's preparation");
  symlinkSync(join(from.root, "node_modules"), join(to.root, "node_modules"));
  await assert.rejects(installDependencies(to.root), /Dependency directory must stay inside the worktree/);
  assert.equal(readFileSync(marker, "utf8"), "operator's preparation");
});

test("dependencies: a failed refresh invalidates the previous preparation", async t => {
  const { root } = fixture(t);
  await installDependencies(root);
  const manifest = readFileSync(join(root, "package.json"), "utf8");
  writeFileSync(join(root, "package.json"), "{conflicted manifest");
  await assert.rejects(installDependencies(root));
  assert.ok(!existsSync(join(root, "node_modules/.crane-dependencies")));
  writeFileSync(join(root, "package.json"), manifest);
  assert.match((await installDependencies(root))!, /Installed dependencies/, "restoring old inputs still needs a verified install");
});
