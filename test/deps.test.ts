import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDependencies, type InstallDependenciesOptions } from "@crane/worktree-deps";
import { copyDependencies, npmInstallMatches } from "../packages/worktree-deps/src/deps.js";
import { elapsed } from "../src/factory/elapsed.js";

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
  const progress: string[] = [];
  const note = await installDependencies(root, { from: root, onProgress: n => progress.push(n) });
  const reason = "preparation not reusable: dependency inputs changed since preparation";
  assert.ok(progress[0]);
  assert.ok(progress[0].includes(reason), progress[0]);
  assert.ok(note!.includes(reason), note!);
  assert.ok(progress[0].indexOf(reason) < progress[0].indexOf("didn't copy"));
  assert.match(note!, /the worktree already has node_modules/);
  assert.equal(realpathSync(join(root, "node_modules/@fixture/contracts")), join(root, "packages/contracts"));
  assert.equal(await installDependencies(root, { onProgress: () => assert.fail("reuse should be silent") }), null,
    "unchanged inputs keep the fast path");
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

test("dependencies: an existing install without a marker explains why it cannot be reused", async t => {
  const { root } = fixture(t);
  await installDependencies(root);
  rmSync(join(root, "node_modules/.crane-dependencies"));
  const sentinel = join(root, "node_modules/sentinel");
  writeFileSync(sentinel, "old install");
  const progress: string[] = [];
  const note = await installDependencies(root, {
    from: root,
    onProgress(n) {
      assert.ok(existsSync(sentinel), "the reason is emitted before the clean install");
      progress.push(n);
    },
  });
  const reason = " · preparation not reusable: the preparation marker is missing or unreadable · didn't copy from your checkout: the worktree already has node_modules";
  assert.deepEqual(progress, [`Installing dependencies (npm ci --no-audit --no-fund)${reason}`]);
  assert.ok(note!.endsWith(reason), note!);
  assert.ok(!existsSync(sentinel), "verification still requires a clean install");
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
    const progress: string[] = [];
    const note = await installDependencies(root, { onProgress: n => progress.push(n) });
    assert.ok(progress[0]);
    const reason = destination
      ? "local package link node_modules/@fixture/contracts does not point to packages/contracts inside the worktree"
      : "local package link node_modules/@fixture/contracts or its target packages/contracts is missing or unreadable";
    assert.ok(progress[0].includes(reason), progress[0]);
    assert.ok(note!.includes(reason), note!);
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
  assert.deepEqual(await copyDependencies(from.root, to.root), { copied: ["node_modules"] });
  assert.equal(realpathSync(join(to.root, "node_modules/@fixture/contracts")), join(to.root, "packages/contracts"));
  assert.equal(await installDependencies(to.root, { from: from.root }), null);

  const stale = fixture(t);
  stale.addWorkspace();
  writeFileSync(join(stale.root, "packages/contracts/package.json"), '{"name":"@fixture/renamed","version":"1.0.0"}');
  assert.match(
    (await copyDependencies(from.root, stale.root) as { skipped: string }).skipped,
    /package\.json files or package manager settings differ/,
    "identical locks cannot hide different workspace manifests",
  );

  const updated = fixture(t);
  updated.addWorkspace();
  for (const root of [from.root, updated.root]) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.description = "changed since preparation";
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  }
  assert.deepEqual(
    await copyDependencies(from.root, updated.root),
    { skipped: "its install predates its current package.json files" },
    "a source preparation with stale inputs cannot be reused",
  );
});

test("dependencies: a skipped copy is explained before the install starts and on the final note", async t => {
  const from = fixture(t);
  const to = fixture(t);
  const lock = JSON.parse(readFileSync(join(to.root, "package-lock.json"), "utf8"));
  lock.name = "different";
  writeFileSync(join(to.root, "package-lock.json"), JSON.stringify(lock));
  await installDependencies(from.root);
  const progress: string[] = [];
  const options: InstallDependenciesOptions = { from: from.root, onProgress: (n) => progress.push(n) };
  const note = await installDependencies(to.root, options);
  const reason = "didn't copy from your checkout: its package-lock.json differs from the worktree's";
  assert.deepEqual(progress, [`Installing dependencies (npm ci --no-audit --no-fund) · preparation not reusable: the preparation marker is missing or unreadable · ${reason}`]);
  assert.match(note!, /^Installed dependencies \(npm ci --no-audit --no-fund\) in \d+(\.\d)?s · /);
  assert.ok(note!.endsWith(reason), note!);
});

test("dependencies: a copied preparation reports progress and its duration", async t => {
  const from = fixture(t);
  const to = fixture(t);
  from.addWorkspace();
  to.addWorkspace();
  await installDependencies(from.root);
  const progress: string[] = [];
  const note = await installDependencies(to.root, { from: from.root, onProgress: (n) => progress.push(n) });
  const reason = " · preparation not reusable: the preparation marker is missing or unreadable";
  assert.deepEqual(progress, [`Copying dependencies from your checkout${reason}`]);
  assert.match(note!, /^Copied dependencies from your checkout \(node_modules\) in \d+\.\ds · /);
  assert.ok(note!.endsWith(reason), note!);
});

test("dependencies: durations read naturally", () => {
  assert.equal(elapsed(420), "0.4s");
  assert.equal(elapsed(12_400), "12s");
  assert.equal(elapsed(161_000), "2m 41s");
});

test("dependencies: cancelling a copy cleans the destination without falling back to installation", async t => {
  const from = fixture(t);
  const to = fixture(t);
  from.addWorkspace();
  to.addWorkspace();
  await installDependencies(from.root);
  const controller = new AbortController();
  const progress: string[] = [];
  await assert.rejects(installDependencies(to.root, {
    from: from.root,
    signal: controller.signal,
    onProgress(note) {
      progress.push(note);
      controller.abort();
    },
  }), { name: "AbortError" });
  assert.deepEqual(progress, ["Copying dependencies from your checkout · preparation not reusable: the preparation marker is missing or unreadable"]);
  assert.ok(!existsSync(join(to.root, "node_modules")), "no partial copy or preparation marker remains");
  assert.ok(existsSync(join(from.root, "node_modules/.crane-dependencies")), "the source preparation stays intact");
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
