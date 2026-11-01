import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dirname, "..", "src");
const webSrc = join(import.meta.dirname, "..", "web", "src");

/** Every relative import in a source file, resolved to a path under `root` like `factory/git`. */
function importsOf(file: string, root = src): string[] {
  const text = readFileSync(join(root, file), "utf8");
  const dir = file.split("/").slice(0, -1);
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
    const parts = [...dir];
    for (const seg of m[1]!.replace(/\.(js|tsx?)$/, "").split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    out.push(parts.join("/"));
  }
  return out;
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

test("boundaries: the report contract doesn't depend on prompts", () => {
  assert.ok(!importsOf("agents/report.ts").includes("agents/prompts"));
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
