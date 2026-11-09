import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { moduleRefs, packageImportViolations, specifiers } from "./support/imports.ts";
import {
  LAZY_RUNTIME_EXCEPTIONS,
  PAGE_PARTS,
  STORE_EXCEPTIONS,
  STORE_READS,
  databaseViolations,
  findCycle,
  pageImportViolations,
  resolveSpec,
  runtimeImports,
  stateChangeViolations,
} from "./support/responsibilities.ts";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");
const webSrc = join(root, "web", "src");
const protocolRoot = join(root, "packages", "agent-protocol");
const policyRoot = join(root, "packages", "agent-policy");
const driversRoot = join(root, "packages", "agent-drivers");
const diagnosticsRoot = join(root, "packages", "diagnostics");

/** Every relative import in a source file, resolved to a path under `root` like `factory/git`. */
function importsOf(file: string, root = src): string[] {
  return specifiers(join(root, file)).filter((spec) => spec.startsWith(".")).map((spec) => resolveSpec(file, spec));
}

const sources = (readdirSync(src, { recursive: true }) as string[])
  .map((f) => f.split("\\").join("/"))
  .filter((f) => f.endsWith(".ts"));

test("boundaries: agent drivers depend only on contracts, protocol, policy, diagnostics and Node", () => {
  const allowed = new Set(["@crane/contracts", "@crane/agent-protocol", "@crane/agent-policy", "@crane/diagnostics"]);
  assert.deepEqual(packageImportViolations(join(driversRoot, "src"), (ref) =>
    ref.spec !== null && (allowed.has(ref.spec) || ref.spec.startsWith("node:"))), []);
});

test("boundaries: storage depends only on Node, SQLite, contracts and backend runtime", () => {
  const allowed = new Set(["@crane/contracts", "@crane/backend-runtime", "better-sqlite3"]);
  assert.deepEqual(packageImportViolations(join(root, "packages/storage/src"), (ref) =>
    ref.spec !== null && (allowed.has(ref.spec) || ref.spec.startsWith("node:"))), []);
});

test("boundaries: only the driver registry imports concrete agents", () => {
  const callers = sources.filter((file) => specifiers(join(src, file)).some((spec) =>
    spec === "@crane/agent-drivers" || spec.startsWith("@crane/agent-drivers/")));
  assert.deepEqual(callers, ["factory/drivers.ts"]);
  for (const file of sources) {
    const bad = importsOf(file).filter((i) => i.startsWith("agents/") || i.includes("packages/agent-drivers/"));
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: factory status queries don't load the scheduler or drivers", () => {
  // Settings keys are a leaf; status reads only them and the served build. See src/factory/state.ts.
  assert.deepEqual(importsOf("factory/settings.ts"), []);
  assert.deepEqual(importsOf("factory/state.ts").sort(), ["application", "factory/settings"]);
  // Only `crane serve` composes a Factory; the API and the other CLI commands only ask about it.
  const server = sources.filter((f) => f.startsWith("server/"));
  assert.ok(server.includes("server/app.ts") && server.includes("server/routes/tasks.ts"), "expected to find server sources");
  for (const file of [...server, "cli/index.ts"]) {
    const bad = importsOf(file).filter((i) => i === "factory/orchestrator");
    assert.deepEqual(bad, [], `${file} imports ${bad.join(", ")}`);
  }
});

test("boundaries: CLI commands load serve and start only when they run", () => {
  const runtime = new Set(["cli/serve", "cli/start"]);
  for (const file of sources.filter((f) => f.startsWith("cli/") && !runtime.has(f.replace(/\.ts$/, "")))) {
    const eager = moduleRefs(join(src, file))
      .filter((ref) => ref.declaration && !ref.typeOnly && ref.spec?.startsWith("."))
      .map((ref) => resolveSpec(file, ref.spec!))
      .filter((path) => runtime.has(path) || path === "factory/orchestrator");
    assert.deepEqual(eager, [], `${file} eagerly imports ${eager.join(", ")}`);
  }
  const lazy = importsOf("cli/commands/serve.ts").filter((path) => runtime.has(path)).sort();
  assert.deepEqual(lazy, ["cli/serve", "cli/start"]);
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
  assert.deepEqual(Object.keys(protocol).sort(), ["AgentRunError", "REPORT_FENCE", "addRunUsage", "combinedCost", "isTransientFailure", "parseReport"].sort());
  for (const path of ["@crane/agent-protocol/src/driver.js", "@crane/agent-protocol/dist/driver.js", "@crane/agent-protocol/driver"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("boundaries: concrete drivers have one ESM entry and keep helpers private", async () => {
  const manifest = JSON.parse(readFileSync(join(driversRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies, {
    "@crane/agent-policy": "0.1.0", "@crane/agent-protocol": "0.1.0", "@crane/contracts": "0.1.0", "@crane/diagnostics": "0.1.0",
  });
  const config = JSON.parse(readFileSync(join(driversRoot, "tsconfig.json"), "utf8"));
  assert.equal(config.compilerOptions.rootDir, "src");
  assert.deepEqual(config.compilerOptions.types, ["node"]);
  assert.deepEqual(config.compilerOptions.lib, ["ES2022"]);
  const api = await import("@crane/agent-drivers");
  assert.deepEqual(Object.keys(api).sort(), ["ClaudeCodeDriver", "CodexDriver", "SimulatedDriver"]);
  for (const path of ["@crane/agent-drivers/src/codex.js", "@crane/agent-drivers/dist/codex.js", "@crane/agent-drivers/codex-pricing", "@crane/agent-drivers/prompts", "@crane/agent-drivers/command-evidence",
    "@crane/agent-drivers/dist/command-guard-hook.js", "@crane/agent-drivers/command-guard-hook"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("boundaries: diagnostics import nothing and have one ambient-free ESM entry", async () => {
  // Dependency preparation uses this too, so it can't bring drivers, Node or the factory along.
  assert.deepEqual(packageImportViolations(join(diagnosticsRoot, "src"), () => false), []);
  const manifest = JSON.parse(readFileSync(join(diagnosticsRoot, "package.json"), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(Object.keys(manifest[field] ?? {}), [], `no ${field}`);
  }
  const config = JSON.parse(readFileSync(join(diagnosticsRoot, "tsconfig.json"), "utf8"));
  assert.deepEqual(config.compilerOptions.types, []);
  assert.deepEqual(config.compilerOptions.lib, ["ES2022"]);
  const api = await import("@crane/diagnostics");
  assert.deepEqual(Object.keys(api), ["sanitizeDiagnosticText"]);
  for (const path of ["@crane/diagnostics/src/sanitize.js", "@crane/diagnostics/dist/sanitize.js", "@crane/diagnostics/sanitize"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
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

test("boundaries: web modules have no import cycles", () => {
  const files = (readdirSync(webSrc, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => /\.tsx?$/.test(f));
  const fileFor = new Map(files.map((f) => [f.replace(/\.tsx?$/, ""), f]));
  const graph = new Map(files.map((f) => [f.replace(/\.tsx?$/, ""), importsOf(f, webSrc).filter((m) => fileFor.has(m))]));
  assert.ok(graph.get("pages/Home")?.includes("components/Section"), "expected to read the web import graph");
  assert.deepEqual(findCycle(graph), null);
});

/** Source files under `dir`, relative to it with forward slashes, matching `pattern`. */
function filesUnder(dir: string, pattern = /\.tsx?$/): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => pattern.test(f) && !f.split("/").includes("node_modules"))
    .sort();
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

test("boundaries: backend and package modules have no runtime import cycles", () => {
  // Type-only imports are erased, so a store/ module typing its `Store` argument is no cycle.
  const roots = [src, ...readdirSync(join(root, "packages")).map((name) => join(root, "packages", name, "src"))];
  for (const dir of roots) {
    const files = filesUnder(dir).filter((f) => !f.endsWith(".d.ts"));
    const graph = new Map(files.map((f) => [f.replace(/\.tsx?$/, ""), runtimeImports(f, read(dir, f))]));
    assert.ok(graph.size > 0, `expected sources in ${dir}`);
    assert.deepEqual(findCycle(graph), null, `import cycle in ${dir}`);
  }
  assert.deepEqual(findCycle(new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]])), ["a", "b", "c", "a"]);
});

/** Production sources by repository path: backend, packages and web. Tests and scripts are not production. */
function productionSources(): string[] {
  const packages = readdirSync(join(root, "packages")).flatMap((name) =>
    filesUnder(join(root, "packages", name, "src")).map((f) => `packages/${name}/src/${f}`));
  return [...filesUnder(src).map((f) => `src/${f}`), ...packages, ...filesUnder(webSrc).map((f) => `web/src/${f}`)];
}

/** Production code that may reach SQLite outside the store, and why. */
const DATABASE_EXCEPTIONS = new Map([
  // `crane setup` checks that the native module loads on this Node runtime, before any Store can open.
  ["src/cli/setup.ts", ["imports better-sqlite3"]],
]);

test("responsibilities: only the store opens and queries the database", () => {
  const owned = (path: string) => path.startsWith("packages/storage/src/");
  const files = productionSources().filter((path) => !owned(path));
  assert.ok(files.includes("src/factory/orchestrator.ts") && files.includes("web/src/App.tsx"), "expected production sources");
  const violations = files.flatMap((path) => databaseViolations(path, read(root, path))
    .filter((v) => !DATABASE_EXCEPTIONS.get(path)?.some((allowed) => v.endsWith(allowed))));
  assert.deepEqual(violations, []);
  for (const [path, allowed] of DATABASE_EXCEPTIONS) {
    const found = databaseViolations(path, read(root, path));
    assert.ok(allowed.every((a) => found.some((v) => v.endsWith(a))), `${path} no longer needs its exception: remove it`);
  }
});

test("responsibilities: the database check catches store.db and better-sqlite3", () => {
  assert.deepEqual(databaseViolations("src/x.ts", 'import Database from "better-sqlite3";\nctx.store.db.prepare("x");\nstore.getTask("t");'), [
    "src/x.ts:1 imports better-sqlite3",
    "src/x.ts:2 uses store.db",
  ]);
  assert.deepEqual(databaseViolations("src/x.ts", 'const { default: D } = await import("better-sqlite3");'), ["src/x.ts:1 imports better-sqlite3"]);
  assert.deepEqual(databaseViolations("src/x.ts", "store.getTask(id);\nconst db = open();"), []);
});

test("responsibilities: web pages don't import other pages or their parts", () => {
  const files = filesUnder(webSrc);
  assert.deepEqual(files.flatMap((path) => pageImportViolations(path, read(webSrc, path))), []);
  // Every parts directory belongs to a page that exists.
  const dirs = new Set(files.filter((f) => /^pages\/[^/]+\//.test(f)).map((f) => f.split("/")[1]!));
  assert.deepEqual([...dirs].filter((dir) => !Object.values(PAGE_PARTS).includes(dir)), []);
  for (const page of Object.keys(PAGE_PARTS)) assert.ok(files.includes(`pages/${page}.tsx`), `PAGE_PARTS names a missing page ${page}`);
});

test("responsibilities: the page check catches cross-page imports", () => {
  assert.deepEqual(pageImportViolations("pages/Home.tsx", 'import { TaskPage } from "./TaskPage";'), ["pages/Home.tsx:1 imports the page pages/TaskPage"]);
  assert.deepEqual(pageImportViolations("pages/Home.tsx", 'import { Timeline } from "./task/Timeline";'), [
    "pages/Home.tsx:1 imports pages/task/Timeline, a part of another page",
  ]);
  assert.deepEqual(pageImportViolations("pages/crew/RunsOn.tsx", 'import { Runs } from "../task/Runs";'), [
    "pages/crew/RunsOn.tsx:1 imports pages/task/Runs, a part of another page",
  ]);
  assert.deepEqual(pageImportViolations("components/Row.tsx", 'import { Runs } from "../pages/task/Runs";'), [
    "components/Row.tsx:1 imports pages/task/Runs, a part of another page",
  ]);
  assert.deepEqual(pageImportViolations("pages/TaskPage.tsx", 'import { Runs } from "./task/Runs";\nimport { Section } from "../components/Section";'), []);
  assert.deepEqual(pageImportViolations("pages/GoalPage.tsx", 'import { GoalBrief } from "./goals/GoalBrief";'), []);
  assert.deepEqual(pageImportViolations("App.tsx", 'import { Home } from "./pages/Home";'), []);
});

test("responsibilities: CLI commands and API routes change state only through OperatorActions", () => {
  const files = [
    ...filesUnder(join(src, "cli", "commands")).map((f) => `cli/commands/${f}`),
    ...filesUnder(join(src, "server", "routes")).map((f) => `server/routes/${f}`),
  ];
  assert.ok(files.includes("cli/commands/do.ts") && files.includes("server/routes/tasks.ts"), "expected command and route sources");
  assert.deepEqual(files.flatMap((path) => stateChangeViolations(path, read(src, path))), []);
  // The allowed reads are all real Store methods, and each exception is still used.
  const facade = read(root, "packages/storage/src/store.ts");
  for (const name of [...STORE_READS, ...Object.keys(STORE_EXCEPTIONS)]) assert.match(facade, new RegExp(`^  ${name}\\(`, "m"), name);
  const used = files.map((path) => read(src, path)).join("\n");
  for (const name of Object.keys(STORE_EXCEPTIONS)) assert.match(used, new RegExp(`store\\.${name}\\(`), `${name} is no longer needed`);
  for (const [path, modules] of Object.entries(LAZY_RUNTIME_EXCEPTIONS)) {
    assert.deepEqual(importsOf(path).filter((m) => modules.includes(m)).sort(), [...modules].sort());
  }
});

test("responsibilities: the state check catches writes, raw database use and writing imports", () => {
  const check = (source: string, path = "cli/commands/sample.ts") => stateChangeViolations(path, source);
  assert.deepEqual(check("ctx.store.getTask(id);\nstore.listRepos();\nstore.syncGoals();\nactions.approve(id);"), []);
  assert.deepEqual(check("ctx.store.updateTask(id, {});\nstore.setPaused(true);\nstore.db.prepare('x');"), [
    "cli/commands/sample.ts:1 calls store.updateTask; change state through OperatorActions",
    "cli/commands/sample.ts:2 calls store.setPaused; change state through OperatorActions",
    "cli/commands/sample.ts:3 calls store.db; change state through OperatorActions",
  ]);
  assert.deepEqual(check('import { landTask } from "../../factory/merge.js";'), ["cli/commands/sample.ts:1 imports factory/merge"]);
  assert.deepEqual(check('import { diffForTask, removeWorktree } from "../../factory/git.js";'), [
    "cli/commands/sample.ts:1 imports removeWorktree from factory/git",
  ]);
  assert.deepEqual(check('import { writeFileSync } from "node:fs";'), ["cli/commands/sample.ts:1 imports writeFileSync from node:fs"]);
  assert.deepEqual(check('import { execFileSync } from "node:child_process";'), ["cli/commands/sample.ts:1 imports node:child_process"]);
  assert.deepEqual(check('await import("../serve.js");'), ["cli/commands/sample.ts:1 loads cli/serve"]);
  assert.deepEqual(check('import type { Store } from "@crane/storage";\nimport { shared } from "./shared.js";'), []);
});

test("boundaries: backend runtime depends only on Node and contract types", () => {
  const runtime = join(root, "packages", "backend-runtime");
  assert.deepEqual(packageImportViolations(join(runtime, "src"), (ref) =>
    ref.spec !== null && (ref.spec.startsWith("node:") || ref.spec === "@crane/contracts" && ref.typeOnly)), []);
  const config = JSON.parse(readFileSync(join(runtime, "tsconfig.json"), "utf8"));
  assert.deepEqual(config.compilerOptions.lib, ["ES2022"]);
  assert.deepEqual(config.compilerOptions.types, ["node"]);
  assert.equal(config.compilerOptions.composite, true);
});
