import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { packageImportViolations, specifiers } from "./support/imports.ts";

const src = join(import.meta.dirname, "..", "src");
const webSrc = join(import.meta.dirname, "..", "web", "src");
const protocolRoot = join(import.meta.dirname, "..", "packages", "agent-protocol");
const policyRoot = join(import.meta.dirname, "..", "packages", "agent-policy");

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
  return specifiers(join(root, file)).filter((spec) => spec.startsWith(".")).map((spec) => resolveSpec(file, spec));
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

test("boundaries: factory status queries don't load the scheduler or drivers", () => {
  // Settings keys are a leaf; status reads only them and the served build. See src/factory/state.ts.
  assert.deepEqual(importsOf("factory/settings.ts"), []);
  assert.deepEqual(importsOf("factory/state.ts").sort(), ["core/webbuild", "factory/settings"]);
  // Only `crane serve` composes a Factory; the API and the other CLI commands only ask about it.
  for (const file of ["server/app.ts", "cli/index.ts"]) {
    const bad = importsOf(file).filter((i) => i === "factory/orchestrator");
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: the agent protocol depends on contract types and nothing else", () => {
  // No concrete drivers, price tables, prompts, policy, subprocesses, Store or factory.
  // Contracts must come in with `import type`, so nothing runs at load.
  assert.deepEqual(packageImportViolations(join(protocolRoot, "src"), (ref) => ref.spec === "@crane/contracts" && ref.typeOnly), []);
});

test("boundaries: production callers use the agent protocol package", () => {
  const oldPaths = new Set(["agents/driver", "agents/report"]);
  for (const file of sources) {
    const bad = importsOf(file).filter((i) => i.startsWith("agent-protocol/") || oldPaths.has(i));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: the agent policy depends on the rule grammar and nothing else", () => {
  // No factory, Store, drivers, prompts, subprocesses or Node modules.
  assert.deepEqual(packageImportViolations(join(policyRoot, "src"), (ref) => ref.spec === "@crane/contracts/rules"), []);
});

test("boundaries: production callers use the agent policy package", () => {
  const oldPaths = new Set(["agents/policy", "core/permissions"]);
  for (const file of sources) {
    const bad = importsOf(file).filter((i) => i.startsWith("agent-policy/") || oldPaths.has(i));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: the private policy has one browser-safe ESM entry", async () => {
  const manifest = JSON.parse(readFileSync(join(policyRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies, { "@crane/contracts": "0.1.0" });
  const config = JSON.parse(readFileSync(join(policyRoot, "tsconfig.json"), "utf8"));
  assert.deepEqual(config.compilerOptions.types, []);
  assert.deepEqual(config.compilerOptions.lib, ["ES2022"]);
  for (const path of ["@crane/agent-policy/src/permissions.js", "@crane/agent-policy/dist/permissions.js", "@crane/agent-policy/permissions", "@crane/agent-policy/denied"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("boundaries: the private protocol has one ESM export", async () => {
  const manifest = JSON.parse(readFileSync(join(protocolRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies, { "@crane/contracts": "0.1.0" });
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
