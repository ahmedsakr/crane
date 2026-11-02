import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFactoryBuildCheck, webBuildOutdated } from "../src/core/webbuild.ts";

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "crane-webbuild-"));
  mkdirSync(join(root, "web", "src", "components"), { recursive: true });
  mkdirSync(join(root, "web", "dist"), { recursive: true });
  const at = (path: string, secondsAgo: number) => {
    const p = join(root, "web", path);
    writeFileSync(p, "x");
    const t = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(p, t, t);
  };
  /** Like `at`, for a file under the checkout root rather than `web/`. */
  const rootAt = (path: string, secondsAgo: number) => {
    const p = join(root, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x");
    const t = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(p, t, t);
  };
  return { root, at, rootAt, done: () => rmSync(root, { recursive: true, force: true }) };
}

// Each case uses its own root, so the short cache never leaks between them.

test("a build newer than every source file is current", () => {
  const c = checkout();
  c.at("src/components/Sheet.tsx", 100);
  c.at("index.html", 100);
  c.at("dist/index.html", 10);
  assert.equal(webBuildOutdated(c.root), false);
  c.done();
});

test("a source file changed after the build makes it outdated, however deep", () => {
  const c = checkout();
  c.at("dist/index.html", 100);
  c.at("src/components/Sheet.tsx", 10);
  assert.equal(webBuildOutdated(c.root), true);
  c.done();
});

test("a change to shared contracts the UI bundles makes the build outdated", () => {
  const shared = [
    "packages/contracts/src/index.ts", "packages/contracts/src/types.ts", "packages/contracts/src/diff.ts", "packages/contracts/src/rules.ts",
    "packages/contracts/package.json", "packages/contracts/tsconfig.json",
  ];
  // Every UI and shared file predates the build; only `changed` (if any) is touched after it.
  const outdatedAfter = (changed: string | null) => {
    const c = checkout();
    c.at("src/components/Sheet.tsx", 100);
    c.at("index.html", 100);
    for (const f of shared) c.rootAt(f, 100);
    c.at("dist/index.html", 50);
    if (changed) c.rootAt(changed, 10);
    const value = webBuildOutdated(c.root);
    c.done();
    return value;
  };
  assert.equal(outdatedAfter(null), false);
  for (const f of shared) assert.equal(outdatedAfter(f), true, f);
});

test("no build, or no source to compare against, is never outdated", () => {
  const noBuild = checkout();
  noBuild.at("src/components/Sheet.tsx", 10);
  assert.equal(webBuildOutdated(noBuild.root), false);
  noBuild.done();

  const noSource = checkout();
  rmSync(join(noSource.root, "web", "src"), { recursive: true });
  noSource.at("dist/index.html", 100);
  assert.equal(webBuildOutdated(noSource.root), false);
  noSource.done();
});

test("a running compiled factory notices source changes and stays outdated after rebuilding until restart", () => {
  const c = checkout();
  try {
    c.rootAt("src/agents/prompts.ts", 100);
    c.rootAt("dist/cli/index.js", 50);
    const outdated = createFactoryBuildCheck(c.root, true);
    assert.equal(outdated(0), false);

    c.rootAt("src/agents/prompts.ts", 20);
    assert.equal(outdated(1_000), false, "cache avoids walking the source tree on every poll");
    assert.equal(outdated(5_000), true, "merged backend changes are noticed without restarting");

    c.rootAt("dist/cli/index.js", 0);
    assert.equal(outdated(10_000), true, "rebuilding doesn't update code already loaded by this process");
    assert.equal(createFactoryBuildCheck(c.root, true)(), false, "a restarted factory sees the new build");
  } finally {
    c.done();
  }
});

test("source-mode factories and builds with no source to compare don't report backend staleness", () => {
  const c = checkout();
  try {
    c.rootAt("dist/cli/index.js", 100);
    c.rootAt("src/agents/prompts.ts", 10);
    assert.equal(createFactoryBuildCheck(c.root, false)(), false, "tsx runs source directly");
    rmSync(join(c.root, "src"), { recursive: true });
    assert.equal(createFactoryBuildCheck(c.root, true)(), false, "installed package with no src or packages directory");
    rmSync(join(c.root, "dist"), { recursive: true });
    assert.equal(createFactoryBuildCheck(c.root, true)(), false, "no compiled build to compare");
  } finally {
    c.done();
  }
});

test("a running factory notices shared contract changes", () => {
  const c = checkout();
  try {
    c.rootAt("packages/contracts/src/types.ts", 100);
    c.rootAt("dist/cli/index.js", 50);
    const outdated = createFactoryBuildCheck(c.root, true);
    assert.equal(outdated(0), false);
    c.rootAt("packages/contracts/src/types.ts", 10);
    assert.equal(outdated(5_000), true);
  } finally {
    c.done();
  }
});

test("every package's inputs stale the factory; only contracts stale the dashboard too", () => {
  const cases: [file: string, stalesDashboard: boolean][] = [
    ["packages/contracts/src/nested/new.ts", true],
    ["packages/agent-protocol/src/driver.ts", false],
    ["packages/agent-policy/package.json", false],
    ["packages/worktree-deps/tsconfig.json", false],
    // Nothing lists a package, so one no code here has heard of counts as well.
    ["packages/not-yet-written/src/nested/new.ts", false],
  ];
  for (const [file, stalesDashboard] of cases) {
    const c = checkout();
    try {
      c.at("src/components/Sheet.tsx", 100);
      c.at("dist/index.html", 50);
      c.rootAt(file, 100);
      c.rootAt("dist/cli/index.js", 50);
      const outdated = createFactoryBuildCheck(c.root, true);
      assert.equal(outdated(0), false, file);
      c.rootAt(file, 10);
      assert.equal(outdated(5_000), true, file);
      assert.equal(webBuildOutdated(c.root), stalesDashboard, file);
    } finally {
      c.done();
    }
  }
});

test("a package added while the factory runs stales it; a package's own build output doesn't", () => {
  const c = checkout();
  try {
    c.rootAt("src/agents/prompts.ts", 100);
    c.rootAt("dist/cli/index.js", 50);
    const outdated = createFactoryBuildCheck(c.root, true);
    assert.equal(outdated(0), false);
    c.rootAt("packages/agent-policy/dist/index.js", 10);
    c.rootAt("packages/agent-policy/node_modules/x/index.js", 10);
    c.rootAt("packages/stray-file", 10);
    assert.equal(outdated(5_000), false);
    c.rootAt("packages/new-package/src/index.ts", 10);
    assert.equal(outdated(10_000), true);
  } finally {
    c.done();
  }
});
