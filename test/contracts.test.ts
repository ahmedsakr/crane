import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_SOURCES } from "../src/core/webbuild.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join("src", "core", "contracts.ts");

/** Module specifiers a file imports or re-exports, static or dynamic. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g)) out.push((m[1] ?? m[2])!);
  return out;
}

/** Resolve a relative specifier the way tsc (NodeNext) and Vite do: `./x.js` and `./x` both mean `./x.ts`. */
function resolveTs(from: string, spec: string): string {
  const base = resolve(dirname(from), spec).replace(/\.js$/, "");
  return /\.tsx?$/.test(base) ? base : `${base}.ts`;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

test("the web UI reaches backend source only through src/core/contracts.ts", () => {
  const web = join(root, "web");
  const escapes: string[] = [];
  for (const file of walk(join(web, "src"))) {
    for (const spec of specifiers(file)) {
      if (!spec.startsWith(".")) continue;
      const target = resolveTs(file, spec);
      if (target.startsWith(web + sep)) continue;
      if (relative(root, target) !== CONTRACTS) escapes.push(`${relative(root, file)} → ${spec}`);
    }
  }
  assert.deepEqual(escapes, []);
});

test("contracts stay browser-safe, and the web build tracks every file they reach", () => {
  const reached = new Set<string>();
  const unsafe: string[] = [];
  const visit = (file: string) => {
    const rel = relative(root, file);
    if (reached.has(rel)) return;
    reached.add(rel);
    for (const spec of specifiers(file)) {
      // No `node:` modules or packages: Vite would bundle them into the browser, or fail to.
      if (!spec.startsWith(".")) unsafe.push(`${rel} → ${spec}`);
      else visit(resolveTs(file, spec));
    }
  };
  visit(join(root, CONTRACTS));
  assert.deepEqual(unsafe, []);
  assert.deepEqual([...reached].sort(), [...SHARED_SOURCES].sort());
});

test("contracts export labels and response helpers, not server internals", async () => {
  const contracts = await import("../src/core/contracts.ts");
  for (const name of ["STATUS_LABEL", "KIND_LABEL", "ruleLabel", "lastMergeOutcome", "choosableDrivers"]) {
    assert.ok(name in contracts, `${name} is exported`);
  }
  for (const name of ["Store", "isAllowed", "suggestRules", "craneHome", "webBuildOutdated"]) {
    assert.ok(!(name in contracts), `${name} is not exported`);
  }
});
