import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webBuildOutdated } from "../src/core/webbuild.ts";

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
  return { root, at, done: () => rmSync(root, { recursive: true, force: true }) };
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

test("a shared contracts file changed after the build makes it outdated", () => {
  const c = checkout();
  c.at("src/components/Sheet.tsx", 100);
  c.at("dist/index.html", 50);
  mkdirSync(join(c.root, "src", "core"), { recursive: true });
  const p = join(c.root, "src", "core", "permissions.ts");
  writeFileSync(p, "x");
  const t = new Date(Date.now() - 10_000);
  utimesSync(p, t, t);
  assert.equal(webBuildOutdated(c.root), true);
  c.done();
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
