import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkWorkspaceLinks, invalidWorkspaceLinks } from "../scripts/check-workspace-links.mjs";

function fixture(t: { after(fn: () => void): void }, workspaces: string[] | { packages: string[] } = ["web", "packages/new"]) {
  const root = mkdtempSync(join(tmpdir(), "crane-workspace-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces }));
  const add = (directory: string, name: string, linked = true) => {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "package.json"), JSON.stringify({ name }));
    const link = join(root, "node_modules", name);
    if (linked) {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(root, directory), link);
    }
    return link;
  };
  return { root, add };
}

test("workspace preflight: names new packages missing from an older install, without changing files", t => {
  const { root, add } = fixture(t);
  add("web", "@crane/web");
  add("packages/new", "@crane/new", false);
  const lock = '{"lockfileVersion":3}\n';
  writeFileSync(join(root, "package-lock.json"), lock);
  assert.deepEqual(invalidWorkspaceLinks(root), ["@crane/new"]);
  const messages: string[] = [];
  assert.equal(checkWorkspaceLinks(root, message => messages.push(message)), 1);
  assert.match(messages[0]!, /@crane\/new/);
  assert.match(messages[0]!, /run npm install/);
  assert.equal(readFileSync(join(root, "package-lock.json"), "utf8"), lock);
  symlinkSync(join(root, "packages/new"), join(root, "node_modules/@crane/new"));
  assert.deepEqual(invalidWorkspaceLinks(root), [], "a repaired install passes");
  assert.equal(checkWorkspaceLinks(root, () => assert.fail("a valid install is silent")), 0);
});

test("workspace preflight: rejects missing, broken, copied and wrong links", t => {
  const { root, add } = fixture(t, ["packages/*"]);
  const other = fixture(t, []);
  for (const kind of ["missing", "broken", "copied", "wrong"]) {
    add(`packages/${kind}`, `@crane/${kind}`, false);
    const link = join(root, "node_modules/@crane", kind);
    mkdirSync(dirname(link), { recursive: true });
    if (kind === "broken") symlinkSync(join(root, "gone"), link);
    if (kind === "copied") mkdirSync(link);
    if (kind === "wrong") {
      other.add(`packages/${kind}`, `@crane/${kind}`, false);
      symlinkSync(join(other.root, "packages", kind), link);
    }
  }
  assert.deepEqual(invalidWorkspaceLinks(root), ["@crane/broken", "@crane/copied", "@crane/missing", "@crane/wrong"]);
});

test("workspace preflight: accepts relative links and discovers names from workspace manifests", t => {
  const { root, add } = fixture(t, { packages: ["web", "packages/*"] });
  add("web", "@crane/web");
  const link = add("packages/new", "unscoped-name");
  rmSync(link);
  symlinkSync("../packages/new", link);
  assert.deepEqual(invalidWorkspaceLinks(root), []);
  add("packages/later", "@crane/later", false);
  assert.deepEqual(invalidWorkspaceLinks(root), ["@crane/later"], "discovery does not use an outdated lockfile");
});

test("workspace preflight: directory globs skip folders without manifests and deduplicate packages", t => {
  const { root, add } = fixture(t, ["packages/**", "packages/new"]);
  add("packages/new", "@crane/new", false);
  add("packages/group/nested", "@crane/nested");
  mkdirSync(join(root, "packages/empty"));
  assert.deepEqual(invalidWorkspaceLinks(root), ["@crane/new"]);
});

test("workspace preflight: all root entry points retain the build:packages gate", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(scripts["build:packages"].startsWith("node scripts/check-workspace-links.mjs && "));
  for (const command of ["typecheck", "pretest", "predev", "predev:server", "precrane"]) {
    assert.ok(scripts[command].startsWith("npm run build:packages"), command);
  }
  // Build runs build:packages without starting npm. test/build.test.ts proves it stops at a bad link.
  assert.equal(scripts.build, "node scripts/build.mjs");
});
