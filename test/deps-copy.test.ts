import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("worktree: picks the install command from the lockfile", async () => {
  const { installCommandFor } = await import("../packages/worktree-deps/src/deps.js");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "crane-install-"));
  assert.equal(installCommandFor(dir), null, "no package.json, nothing to install");
  writeFileSync(join(dir, "package.json"), "{}");
  assert.equal(installCommandFor(dir), null, "no lockfile, nothing to install");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  assert.equal(installCommandFor(dir)?.cmd, "npm");
  assert.deepEqual(installCommandFor(dir)?.args.slice(0, 1), ["ci"]);
  mkdirSync(join(dir, "node_modules"));
  assert.equal(installCommandFor(dir)?.cmd, "npm", "an existing directory alone does not prove dependencies are current");
});

test("worktree: copies dependencies from the checkout only when they match the lockfile", async () => {
  const { copyDependencies } = await import("../packages/worktree-deps/src/deps.js");
  const { installDependencies } = await import("@crane/worktree-deps");
  const { writeFileSync, mkdirSync, symlinkSync, readlinkSync, readFileSync, existsSync } = await import("node:fs");
  const lock = (extra = {}) =>
    JSON.stringify({
      packages: {
        "": { name: "x" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/fsevents": { version: "2.0.0", optional: true },
        "web/node_modules/b": { version: "2.0.0" },
        ...extra,
      },
    });
  const hidden = (version = "1.0.0") =>
    JSON.stringify({ packages: { "node_modules/a": { version }, "web/node_modules/b": { version: "2.0.0" } } });

  const setup = () => {
    const from = mkdtempSync(join(tmpdir(), "crane-from-"));
    const to = mkdtempSync(join(tmpdir(), "crane-to-"));
    for (const root of [from, to]) {
      mkdirSync(join(root, "web"));
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "web", "package.json"), "{}");
      writeFileSync(join(root, "package-lock.json"), lock());
    }
    mkdirSync(join(from, "node_modules", "a"), { recursive: true });
    mkdirSync(join(from, "web", "node_modules", "b"), { recursive: true });
    writeFileSync(join(from, "node_modules", "a", "index.js"), "module.exports = 1");
    writeFileSync(join(from, "node_modules", ".package-lock.json"), hidden());
    // A relative link stays as is; an absolute one into the checkout gets pointed at the worktree.
    symlinkSync("../../web", join(from, "node_modules", "web"));
    symlinkSync(join(from, "web"), join(from, "node_modules", "web-abs"));
    return { from, to };
  };

  // Workspace packages are found from the package.json files git tracks.
  const { execFileSync } = await import("node:child_process");
  // No stdin pipe: closing one fails with EPERM in Codex's sandbox.
  const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const gitInit = (dir: string) => {
    git(dir, "init", "-q");
    git(dir, "add", "package.json", "web/package.json");
  };

  {
    const { from, to } = setup();
    gitInit(from);
    gitInit(to);
    assert.deepEqual(await copyDependencies(from, to), { copied: ["node_modules", "web/node_modules"] });
    assert.equal(readFileSync(join(to, "node_modules", "a", "index.js"), "utf8"), "module.exports = 1");
    assert.ok(existsSync(join(to, "web", "node_modules", "b")));
    assert.equal(readlinkSync(join(to, "node_modules", "web")), "../../web");
    assert.equal(readlinkSync(join(to, "node_modules", "web-abs")), "../web");
    assert.deepEqual(await copyDependencies(from, to), { skipped: "the worktree already has node_modules" }, "already in place");
    assert.equal(await installDependencies(to, { from }), null, "nothing left to do");
  }
  {
    const { from, to } = setup();
    writeFileSync(join(to, "package-lock.json"), lock({ "node_modules/c": { version: "3.0.0" } }));
    assert.deepEqual(
      await copyDependencies(from, to),
      { skipped: "its package-lock.json differs from the worktree's" },
      "the worktree pins something else",
    );
  }
  {
    const { from, to } = setup();
    writeFileSync(join(from, "node_modules", ".package-lock.json"), hidden("0.9.0"));
    assert.deepEqual(
      await copyDependencies(from, to),
      { skipped: "what it has installed doesn't match its package-lock.json (run npm install there)" },
      "the checkout's install is stale",
    );
  }
  {
    const { from, to } = setup();
    assert.deepEqual(await copyDependencies(from, to), { copied: ["node_modules"] }, "outside git, just the root");
  }
});

test("worktree: npm's record of what's installed must agree with the lockfile", async () => {
  const { npmInstallMatches } = await import("../packages/worktree-deps/src/deps.js");
  const lock = { packages: { "": {}, "node_modules/a": { version: "1" }, "node_modules/b": { version: "1", optional: true } } };
  assert.ok(npmInstallMatches(lock, { packages: { "node_modules/a": { version: "1" } } }));
  assert.ok(!npmInstallMatches(lock, { packages: {} }), "a pinned package is missing");
  assert.ok(!npmInstallMatches(lock, { packages: { "node_modules/a": { version: "2" } } }), "wrong version");
  assert.ok(
    !npmInstallMatches(lock, { packages: { "node_modules/a": { version: "1" }, "node_modules/z": { version: "1" } } }),
    "something extra is installed",
  );
  assert.ok(!npmInstallMatches({}, { packages: {} }));
});
