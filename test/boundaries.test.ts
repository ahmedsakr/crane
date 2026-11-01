import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dirname, "..", "src");
const webSrc = join(import.meta.dirname, "..", "web", "src");

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
  // No concrete drivers, price tables, prompts, policy, subprocesses, Store or factory: see src/agent-protocol/index.ts.
  const files = sources.filter((f) => f.startsWith("agent-protocol/"));
  assert.ok(files.includes("agent-protocol/index.ts"), "expected to find the agent protocol");
  for (const file of files) {
    const text = readFileSync(join(src, file), "utf8");
    assert.ok(!/\b(import|require)\s*\(/.test(text), `${file} loads a module dynamically`);
    // Every import and re-export statement, including bare and `node:` specifiers.
    for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^;"]*?\bfrom\s*)?"([^"]+)"/gm)) {
      const spec = m[3]!;
      const target = spec.startsWith(".") ? resolveSpec(file, spec) : spec;
      if (target.startsWith("agent-protocol/")) continue;
      assert.equal(target, "core/contracts", `${file} imports "${spec}"`);
      assert.ok(m[1] === "import" && m[2], `${file} must import contracts with \`import type\`, so nothing runs at load`);
    }
  }
});

test("boundaries: the agent protocol is reached only through its entry point", () => {
  // So making it a package means swapping one specifier.
  for (const file of sources.filter((f) => !f.startsWith("agent-protocol/"))) {
    const bad = importsOf(file).filter((i) => i.startsWith("agent-protocol/") && i !== "agent-protocol/index");
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
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
  const protocol = await import("../src/agent-protocol/index.ts");
  const driver = await import("../src/agents/driver.ts");
  const report = await import("../src/agents/report.ts");
  const pricing = await import("../src/agents/codex-pricing.ts");
  assert.equal(driver.AgentRunError, protocol.AgentRunError);
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
