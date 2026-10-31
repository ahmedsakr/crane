import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dirname, "..", "src");

/** Every relative import in a source file, resolved to a path under src/ like `factory/git`. */
function importsOf(file: string): string[] {
  const text = readFileSync(join(src, file), "utf8");
  const dir = file.split("/").slice(0, -1);
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
    const parts = [...dir];
    for (const seg of m[1]!.replace(/\.js$/, "").split("/")) {
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
