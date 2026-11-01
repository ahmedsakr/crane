import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SHARED_SOURCES } from "../src/core/webbuild.ts";
import { parseRule } from "@crane/contracts/rules";
import { ruleLabel } from "@crane/contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contracts = join(root, "packages", "contracts");
const agentProtocol = join(root, "packages", "agent-protocol");
const agentPolicy = join(root, "packages", "agent-policy");
const worktreeDeps = join(root, "packages", "worktree-deps");
const web = join(root, "web");
const within = (dir: string, path: string) => path === dir || path.startsWith(dir + sep);

/** Include type imports, re-exports, side effects, and literal dynamic imports/require calls. */
function specifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal.text);
    } else if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) {
      out.push(node.expression.text);
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", ".git"].includes(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.[cm]?[jt]sx?$/.test(name) ? [p] : [];
  });
}

const workspace = (file: string) => [contracts, agentProtocol, agentPolicy, worktreeDeps, web].find((dir) => within(dir, file)) ?? root;

test("application workspaces use package entry points, never each other's source paths", () => {
  const escapes: string[] = [];
  // Repository tests may import the implementation under test (including web helpers).
  const files = ["src", "scripts", "web", "packages/contracts", "packages/agent-protocol", "packages/agent-policy", "packages/worktree-deps"].flatMap((d) => walk(join(root, d)));
  for (const file of files) {
    for (const spec of specifiers(file)) {
      if (spec.startsWith(".") || isAbsolute(spec)) {
        if (workspace(file) !== workspace(resolve(dirname(file), spec))) escapes.push(`${relative(root, file)} → ${spec}`);
      } else if (spec.startsWith("@crane/contracts/") && spec !== "@crane/contracts/rules") {
        escapes.push(`${relative(root, file)} → ${spec}`);
      } else if (spec.startsWith("@crane/agent-protocol/") || spec.startsWith("@crane/agent-policy/") || spec.startsWith("@crane/worktree-deps/")) {
        escapes.push(`${relative(root, file)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(escapes, []);
  const config = JSON.parse(readFileSync(join(web, "tsconfig.json"), "utf8"));
  assert.deepEqual(config.include, ["src"], "web doesn't compile backend source");
  assert.equal(config.compilerOptions.paths, undefined, "no aliases around package exports");
});

test("contracts stay self-contained and browser-safe; build staleness tracks all inputs", () => {
  const files = walk(join(contracts, "src"));
  const unsafe: string[] = [];
  for (const file of files) {
    for (const spec of specifiers(file)) {
      if (!spec.startsWith(".") || !within(contracts, resolve(dirname(file), spec))) {
        unsafe.push(`${relative(root, file)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(unsafe, []);
  const manifest = JSON.parse(readFileSync(join(contracts, "package.json"), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(Object.keys(manifest[field] ?? {}), [], `no ${field}`);
  }
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./rules"]);
  const inputs = [...files, join(contracts, "package.json"), join(contracts, "tsconfig.json")];
  assert.deepEqual(inputs.map((f) => relative(root, f)).sort(), [...SHARED_SOURCES].sort());
});

test("the public package exports labels and helpers, hides enforcement and implementation paths", async () => {
  const api = await import("@crane/contracts");
  for (const name of ["STATUS_LABEL", "KIND_LABEL", "AUTONOMY_LABEL", "driverLabel", "ruleLabel", "settingsLabel", "lastMergeOutcome", "choosableDrivers"]) {
    assert.ok(name in api, `${name} is exported`);
  }
  for (const name of ["Store", "parseRule", "isAllowed", "overlapsDenied", "suggestRules", "splitCommand", "craneHome", "webBuildOutdated"]) {
    assert.ok(!(name in api), `${name} is not exported`);
  }
  for (const path of ["@crane/contracts/src/types.js", "@crane/contracts/dist/types.js"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("shared rule grammar and labels preserve backend permission syntax", () => {
  const cases: [string, ReturnType<typeof parseRule>, string][] = [
    ["Read", { tool: "Read", pattern: null }, "Read"],
    [" Bash(npm ci:*) ", { tool: "Bash", pattern: "npm ci:*" }, "npm ci"],
    ["Bash(git status*)", { tool: "Bash", pattern: "git status*" }, "git status"],
    ["Read(src/**)", { tool: "Read", pattern: "src/**" }, "Read src/**"],
    ["mcp__tools__call", { tool: "mcp__tools__call", pattern: null }, "mcp__tools__call"],
    ["Bash()", null, "Bash()"],
    ["invalid rule", null, "invalid rule"],
  ];
  for (const [rule, parsed, label] of cases) {
    assert.deepEqual(parseRule(rule), parsed, rule);
    assert.equal(ruleLabel(rule), label, rule);
  }
});
