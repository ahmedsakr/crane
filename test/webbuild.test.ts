import { test, type TestContext } from "node:test";
import { temporaryRoot } from "./support/fixtures.js";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFactoryBuildCheck, webBuildOutdated } from "@crane/backend-runtime";
import { factoryRoot, factoryBuildOutdated } from "../src/application.js";
import { bindApplication, factoryRoot as runtimeRoot, factoryBuildOutdated as runtimeOutdated } from "@crane/backend-runtime";

test("source application keeps its checkout identity with compiled workspace dependencies", () => {
  assert.equal(factoryRoot(), join(import.meta.dirname, ".."));
  assert.equal(factoryBuildOutdated(), false);
  assert.equal(runtimeRoot, factoryRoot, "factory consumers share the application's bound identity");
  assert.equal(runtimeOutdated, factoryBuildOutdated);
  assert.throws(() => bindApplication("/another-application", true), /already bound/);
  assert.equal(runtimeRoot(), join(import.meta.dirname, ".."));
});

function checkout(ctx: TestContext) {
  const root = temporaryRoot(ctx, "crane-webbuild-");
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
  return { root, at, rootAt };
}

// Each case uses its own root, so the short cache never leaks between them.

test("a build newer than every source file is current", (ctx) => {
  const c = checkout(ctx);
  c.at("src/components/Sheet.tsx", 100);
  c.at("index.html", 100);
  c.at("dist/index.html", 10);
  assert.equal(webBuildOutdated(c.root), false);
});

test("a source file changed after the build makes it outdated, however deep", (ctx) => {
  const c = checkout(ctx);
  c.at("dist/index.html", 100);
  c.at("src/components/Sheet.tsx", 10);
  assert.equal(webBuildOutdated(c.root), true);
});

test("a change to shared contracts the UI bundles makes the build outdated", (ctx) => {
  const shared = [
    "packages/contracts/src/index.ts", "packages/contracts/src/types.ts", "packages/contracts/src/diff.ts", "packages/contracts/src/rules.ts",
    "packages/contracts/package.json", "packages/contracts/tsconfig.json",
  ];
  // Every UI and shared file predates the build; only `changed` (if any) is touched after it.
  const outdatedAfter = (changed: string | null) => {
    const c = checkout(ctx);
    c.at("src/components/Sheet.tsx", 100);
    c.at("index.html", 100);
    for (const f of shared) c.rootAt(f, 100);
    c.at("dist/index.html", 50);
    if (changed) c.rootAt(changed, 10);
    const value = webBuildOutdated(c.root);
    return value;
  };
  assert.equal(outdatedAfter(null), false);
  for (const f of shared) assert.equal(outdatedAfter(f), true, f);
});

test("no build, or no source to compare against, is never outdated", (ctx) => {
  const noBuild = checkout(ctx);
  noBuild.at("src/components/Sheet.tsx", 10);
  assert.equal(webBuildOutdated(noBuild.root), false);

  const noSource = checkout(ctx);
  rmSync(join(noSource.root, "web", "src"), { recursive: true });
  noSource.at("dist/index.html", 100);
  assert.equal(webBuildOutdated(noSource.root), false);
});

test("a running compiled factory notices source changes and stays outdated after rebuilding until restart", (ctx) => {
  const c = checkout(ctx);
  c.rootAt("packages/factory/src/drivers.ts", 100);
  c.rootAt("dist/cli/index.js", 50);
  const outdated = createFactoryBuildCheck(c.root, true);
  assert.equal(outdated(0), false);

  c.rootAt("packages/factory/src/drivers.ts", 20);
  assert.equal(outdated(1_000), false, "cache avoids walking the source tree on every poll");
  assert.equal(outdated(5_000), true, "merged backend changes are noticed without restarting");

  c.rootAt("dist/cli/index.js", 0);
  assert.equal(outdated(10_000), true, "rebuilding doesn't update code already loaded by this process");
  assert.equal(createFactoryBuildCheck(c.root, true)(), false, "a restarted factory sees the new build");
});

test("source-mode factories and builds with no source to compare don't report backend staleness", (ctx) => {
  const c = checkout(ctx);
  c.rootAt("dist/cli/index.js", 100);
  c.rootAt("packages/factory/src/drivers.ts", 10);
  assert.equal(createFactoryBuildCheck(c.root, false)(), false, "tsx runs source directly");
  rmSync(join(c.root, "packages"), { recursive: true });
  assert.equal(createFactoryBuildCheck(c.root, true)(), false, "installed package with no src or packages directory");
  rmSync(join(c.root, "dist"), { recursive: true });
  assert.equal(createFactoryBuildCheck(c.root, true)(), false, "no compiled build to compare");
});

test("a running factory notices shared contract changes", (ctx) => {
  const c = checkout(ctx);
  c.rootAt("packages/contracts/src/types.ts", 100);
  c.rootAt("dist/cli/index.js", 50);
  const outdated = createFactoryBuildCheck(c.root, true);
  assert.equal(outdated(0), false);
  c.rootAt("packages/contracts/src/types.ts", 10);
  assert.equal(outdated(5_000), true);
});

test("every package's inputs stale the factory; only contracts stale the dashboard too", (ctx) => {
  const cases: [file: string, stalesDashboard: boolean][] = [
    ["packages/contracts/src/nested/new.ts", true],
    ["packages/agent-protocol/src/driver.ts", false],
    ["packages/agent-drivers/src/prompts.ts", false],
    ["packages/agent-policy/package.json", false],
    ["packages/worktree-deps/tsconfig.json", false],
    ["packages/backend-runtime/src/actor.ts", false],
    // Nothing lists a package, so one no code here has heard of counts as well.
    ["packages/not-yet-written/src/nested/new.ts", false],
  ];
  for (const [file, stalesDashboard] of cases) {
    const c = checkout(ctx);
    c.at("src/components/Sheet.tsx", 100);
    c.at("dist/index.html", 50);
    c.rootAt(file, 100);
    c.rootAt("dist/cli/index.js", 50);
    const outdated = createFactoryBuildCheck(c.root, true);
    assert.equal(outdated(0), false, file);
    c.rootAt(file, 10);
    assert.equal(outdated(5_000), true, file);
    assert.equal(webBuildOutdated(c.root), stalesDashboard, file);
  }
});

test("Nx's config and local cache don't stale the factory or dashboard, since no build of either runs Nx", (ctx) => {
  // test/build.test.ts checks that no build, dev or dashboard workflow starts Nx. If one ever does,
  // these files become build inputs and this list has to move to the staling side.
  const files = [
    "nx.json", "web/project.json", "test/project.json", "packages/contracts/project.json",
    ".nx/cache/123/outputs/dist/index.js", ".nx/workspace-data/project-graph.json",
    "packages/contracts/dist/index.js",
  ];
  const c = checkout(ctx);
  c.at("src/components/Sheet.tsx", 100);
  c.at("dist/index.html", 50);
  c.rootAt("packages/factory/src/drivers.ts", 100);
  c.rootAt("packages/contracts/src/index.ts", 100);
  c.rootAt("dist/cli/index.js", 50);
  const outdated = createFactoryBuildCheck(c.root, true);
  assert.equal(outdated(0), false);
  for (const file of files) c.rootAt(file, 10);
  assert.equal(outdated(5_000), false, "Nx metadata alone");
  assert.equal(webBuildOutdated(c.root), false, "Nx metadata alone");
  // The backend's project.json sits in src/, which counts as a whole: conservative, never falsely current.
  c.rootAt("src/project.json", 10);
  assert.equal(outdated(10_000), true);
});

test("a package added while the factory runs stales it; a package's own build output doesn't", (ctx) => {
  const c = checkout(ctx);
  c.rootAt("packages/factory/src/drivers.ts", 100);
  c.rootAt("dist/cli/index.js", 50);
  const outdated = createFactoryBuildCheck(c.root, true);
  assert.equal(outdated(0), false);
  c.rootAt("packages/agent-policy/dist/index.js", 10);
  c.rootAt("packages/agent-policy/node_modules/x/index.js", 10);
  c.rootAt("packages/stray-file", 10);
  assert.equal(outdated(5_000), false);
  c.rootAt("packages/new-package/src/index.ts", 10);
  assert.equal(outdated(10_000), true);
});
