import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { AGENT_PROTOCOL_SOURCES } from "../src/core/webbuild.ts";

const src = join(import.meta.dirname, "..", "src");
const webSrc = join(import.meta.dirname, "..", "web", "src");
const protocolRoot = join(import.meta.dirname, "..", "packages", "agent-protocol");
const protocolSrc = join(protocolRoot, "src");
const protocolSources = (readdirSync(protocolSrc, { recursive: true }) as string[])
  .map((f) => f.split("\\").join("/"))
  .filter((f) => f.endsWith(".ts"));

/** A relative specifier in `file`, resolved to a path under the same root like `factory/git`. */
function resolveSpec(file: string, spec: string): string {
  const parts = file.split("/").slice(0, -1);
  for (const seg of spec.replace(/\.(js|tsx?)$/, "").split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Every relative import in a source file, resolved to a path under `root` like `factory/git`. */
function importsOf(file: string, root = src): string[] {
  const text = readFileSync(join(root, file), "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)].map((m) => resolveSpec(file, m[1]!));
}

const sources = (readdirSync(src, { recursive: true }) as string[])
  .map((f) => f.split("\\").join("/"))
  .filter((f) => f.endsWith(".ts"));

test("boundaries: agents never reach into the factory", () => {
  for (const file of sources.filter((f) => f.startsWith("agents/"))) {
    const bad = importsOf(file).filter((i) => i.startsWith("factory/") || i.startsWith("server/") || i.startsWith("cli/"));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: core depends on nothing above it", () => {
  // Factory, server, CLI, and agents all build on core, so core importing any of them is a directory-level loop.
  const core = sources.filter((f) => f.startsWith("core/"));
  assert.ok(core.includes("core/store.ts"), "expected to find core sources");
  for (const file of core) {
    const bad = importsOf(file).filter((i) => /^(factory|server|cli|agents)\//.test(i));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: only the driver registry imports concrete agents", () => {
  const concrete = new Set(["agents/claude-code", "agents/codex", "agents/simulated"]);
  for (const file of sources.filter((f) => f !== "factory/drivers.ts" && !concrete.has(f.replace(/\.ts$/, "")))) {
    const bad = importsOf(file).filter((i) => concrete.has(i));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: the agent protocol depends on contract types and nothing else", () => {
  // No concrete drivers, price tables, prompts, policy, subprocesses, Store or factory.
  assert.ok(protocolSources.includes("index.ts"), "expected to find the agent protocol");
  for (const file of protocolSources) {
    const source = ts.createSourceFile(file, readFileSync(join(protocolSrc, file), "utf8"), ts.ScriptTarget.Latest, true);
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
          const target = resolve(protocolSrc, dirname(file), spec.replace(/\.js$/, ".ts"));
          assert.ok(protocolSources.some((f) => join(protocolSrc, f) === target), `${file} imports outside the package: ${spec}`);
        } else {
          assert.equal(spec, "@crane/contracts", `${file} imports "${spec}"`);
          assert.ok(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly,
            `${file} must import contracts with \`import type\`, so nothing runs at load`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test("boundaries: production callers use the agent protocol package", () => {
  for (const file of sources) {
    const bad = importsOf(file).filter((i) => i.startsWith("agent-protocol/"));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: the agent policy depends on the rule grammar and nothing else", () => {
  // No factory, Store, drivers, prompts, subprocesses or Node modules: see src/agent-policy/index.ts.
  const files = sources.filter((f) => f.startsWith("agent-policy/"));
  assert.ok(files.includes("agent-policy/index.ts"), "expected to find the agent policy");
  for (const file of files) {
    const text = readFileSync(join(src, file), "utf8");
    assert.ok(!/\b(import|require)\s*\(/.test(text), `${file} loads a module dynamically`);
    for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^;"]*?\bfrom\s*)?"([^"]+)"/gm)) {
      const spec = m[3]!;
      const target = spec.startsWith(".") ? resolveSpec(file, spec) : spec;
      if (target.startsWith("agent-policy/")) continue;
      assert.equal(target, "@crane/contracts/rules", `${file} imports "${spec}"`);
    }
  }
});

test("boundaries: the agent policy is reached only through its entry point", () => {
  // So making it a package means swapping one specifier. The old paths are re-exports for older branches only.
  const oldPaths = new Set(["agents/policy", "core/permissions"]);
  for (const file of sources.filter((f) => !f.startsWith("agent-policy/"))) {
    const bad = importsOf(file).filter((i) => (i.startsWith("agent-policy/") && i !== "agent-policy/index") || oldPaths.has(i));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: old policy paths re-export the agent policy", async () => {
  const policy = await import("../src/agent-policy/index.ts");
  const oldPolicy = await import("../src/agents/policy.ts");
  const oldPermissions = await import("../src/core/permissions.ts");
  assert.equal(oldPolicy.ALWAYS_DENIED, policy.ALWAYS_DENIED);
  assert.equal(oldPermissions.isAllowed, policy.isAllowed);
  assert.equal(oldPermissions.overlapsDenied, policy.overlapsDenied);
  assert.equal(oldPermissions.suggestRules, policy.suggestRules);
});

test("boundaries: the private protocol has one ESM export and tracks every backend build input", async () => {
  const manifest = JSON.parse(readFileSync(join(protocolRoot, "package.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.exports, { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } });
  assert.deepEqual(manifest.dependencies, { "@crane/contracts": "0.1.0" });
  const inputs = [...protocolSources.map((f) => join("src", f)), "package.json", "tsconfig.json"];
  assert.deepEqual([...AGENT_PROTOCOL_SOURCES].sort(), inputs.map((f) => join("packages", "agent-protocol", f)).sort());
  const protocol = await import("@crane/agent-protocol");
  assert.deepEqual(Object.keys(protocol).sort(), ["AgentRunError", "REPORT_FENCE", "combinedCost", "isTransientFailure", "parseReport"].sort());
  for (const path of ["@crane/agent-protocol/src/driver.js", "@crane/agent-protocol/dist/driver.js", "@crane/agent-protocol/driver"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("boundaries: provider price tables stay with their drivers", () => {
  // The scheduler combines costs through the protocol; it never prices a provider's tokens itself.
  for (const file of sources.filter((f) => !f.startsWith("agents/"))) {
    const bad = importsOf(file).filter((i) => /^agents\/.*pricing$/.test(i));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: old agent paths re-export the protocol's one AgentRunError", async () => {
  // Retry handling checks instanceof, so a second class at an old path would silently stop retries.
  const protocol = await import("@crane/agent-protocol");
  const legacy = await import("../src/agent-protocol/index.ts");
  const driver = await import("../src/agents/driver.ts");
  const report = await import("../src/agents/report.ts");
  const pricing = await import("../src/agents/codex-pricing.ts");
  assert.equal(driver.AgentRunError, protocol.AgentRunError);
  assert.deepEqual(legacy, protocol);
  assert.equal(driver.isTransientFailure, protocol.isTransientFailure);
  assert.equal(report.parseReport, protocol.parseReport);
  assert.equal(report.REPORT_FENCE, protocol.REPORT_FENCE);
  assert.equal(pricing.combinedCost, protocol.combinedCost);
  assert.ok(new protocol.AgentRunError("x") instanceof driver.AgentRunError);
});

test("boundaries: only the web entry point imports App", () => {
  // App imports every page, so a page importing App (say, for useApp) is a cycle. Shared app state lives in lib/app-context.
  const webSources = (readdirSync(webSrc, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => /\.tsx?$/.test(f) && f !== "main.tsx" && f !== "App.tsx");
  assert.ok(webSources.some((f) => f.startsWith("pages/")), "expected to find web pages");
  for (const file of webSources) {
    assert.ok(!importsOf(file, webSrc).includes("App"), `${file} imports App`);
  }
});
