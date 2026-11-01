import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { WORKTREE_DEPS_SOURCES } from "../src/core/webbuild.ts";

const root = join(import.meta.dirname, "..", "packages", "worktree-deps");
const src = join(root, "src");
const sources = (readdirSync(src, { recursive: true }) as string[]).filter(f => f.endsWith(".ts"));

test("worktree dependencies import only their implementation and Node modules", () => {
  const allowed = new Set([
    "node:child_process", "node:util", "node:fs", "node:fs/promises", "node:crypto", "node:path",
  ]);
  assert.ok(sources.includes("index.ts"));
  for (const file of sources) {
    const source = ts.createSourceFile(file, readFileSync(join(src, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      assert.ok(!ts.isImportEqualsDeclaration(node) && !ts.isImportTypeNode(node), `${file} uses an alternate import form`);
      if (ts.isCallExpression(node)) {
        assert.ok(node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
          !(ts.isIdentifier(node.expression) && node.expression.text === "require"), `${file} loads a module dynamically`);
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier));
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith(".")) {
          const target = resolve(src, dirname(file), spec.replace(/\.js$/, ".ts"));
          assert.ok(sources.some(f => join(src, f) === target), `${file} imports outside the package: ${spec}`);
        } else {
          assert.ok(allowed.has(spec), `${file} imports ${spec}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test("the private dependency package exposes only installation and tracks every build input", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.exports, { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } });
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(Object.keys(manifest[field] ?? {}), [], `no ${field}`);
  }
  const inputs = [...sources.map(f => join("src", f)), "package.json", "tsconfig.json"];
  assert.deepEqual([...WORKTREE_DEPS_SOURCES].sort(), inputs.map(f => join("packages", "worktree-deps", f)).sort());
  const api = await import("@crane/worktree-deps");
  assert.deepEqual(Object.keys(api), ["installDependencies"]);
  for (const path of ["@crane/worktree-deps/src/deps.js", "@crane/worktree-deps/dist/deps.js", "@crane/worktree-deps/deps"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});
