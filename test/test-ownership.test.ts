import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TEST_GROUPS, type TestGroup } from "../scripts/test-groups.ts";
import { affectedTestGroups, dependencyProblems, rootSuites, suiteCatalog, testPlan } from "../scripts/test-ownership.ts";
import { importedTestProjects, projectClosure, testProjects } from "../scripts/test-projects.ts";
import { temporaryRoot } from "./support/fixtures.ts";

const root = join(import.meta.dirname, "..");
const ids = TEST_GROUPS.map((group) => group.id);

test("test ownership: every root suite has exactly one explicit execution owner", () => {
  const actual = rootSuites(root);
  const catalog = suiteCatalog(actual);
  assert.deepEqual(catalog.problems, [], "update ownership for added/deleted suites");
  assert.deepEqual(TEST_GROUPS.flatMap((group) => group.suites).sort(), actual);
  assert.equal(Object.keys(catalog.owners).length, actual.length);
  assert.deepEqual([...new Set(TEST_GROUPS.map((group) => group.kind))].sort(), ["architecture", "backend", "build", "package", "web"]);
});

test("test ownership: full execution equals the original immediate shell glob, once per file", () => {
  const original = readdirSync(join(root, "test")).filter((name) => !name.startsWith(".") && name.endsWith(".test.ts"))
    .map((name) => `test/${name}`).sort();
  assert.deepEqual(testPlan(root).suites, original);
  const grouped = TEST_GROUPS.flatMap((group) => testPlan(root, [group.id]).suites);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(grouped.sort(), original);
});

test("test ownership: named imports and helper chains fit the declared Nx project dependencies", () => {
  assert.deepEqual(dependencyProblems(root, TEST_GROUPS, testProjects(root)), []);
});

function put(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

const fixtureGroups: TestGroup[] = [
  { id: "package", kind: "package", projects: ["@fixture/one"], suites: ["test/package.test.ts"] },
  { id: "backend", kind: "backend", projects: ["backend"], suites: ["test/backend.test.ts"] },
  { id: "web", kind: "web", projects: ["@fixture/web"], suites: ["test/web.test.ts"] },
  { id: "architecture", kind: "architecture", projects: [], repositoryWide: true, suites: ["test/scan.test.ts"] },
  { id: "build", kind: "build", projects: [], repositoryWide: true, suites: ["test/build.test.ts"] },
];

function fixture(t: Parameters<typeof temporaryRoot>[0]) {
  const root = temporaryRoot(t, "crane-test-ownership-");
  const projects = [
    { root: "packages/one", name: "@fixture/one", implicitDependencies: ["@fixture/shared"] },
    { root: "packages/shared", name: "@fixture/shared", implicitDependencies: [] },
    { root: "src", name: "backend", implicitDependencies: ["@fixture/one"] },
    { root: "web", name: "@fixture/web", implicitDependencies: ["@fixture/shared"] },
    { root: "test", name: "checks", implicitDependencies: ["backend", "@fixture/web"] },
  ];
  for (const project of projects) put(root, `${project.root}/project.json`, JSON.stringify(project));
  for (const file of ["packages/one/src/private.ts", "packages/shared/src/index.ts", "src/main.ts", "web/src/view.ts"]) put(root, file, "export {};\n");
  put(root, "test/package.test.ts", 'import "../packages/one/src/private.js";');
  put(root, "test/backend.test.ts", 'import "./support/outer.js"; import "../src/main.js";');
  put(root, "test/support/outer.ts", 'export * from "./inner.js";');
  put(root, "test/support/inner.ts", 'import "../../packages/shared/src/index.js";');
  put(root, "test/web.test.ts", 'import "../web/src/view.ts"; import type {} from "@fixture/shared";');
  put(root, "test/scan.test.ts", 'import { readdirSync } from "node:fs"; readdirSync("packages");');
  put(root, "test/build.test.ts", 'import { readFileSync } from "node:fs"; readFileSync("package.json");');
  const plan = (paths: string[] | null) => affectedTestGroups(root, paths, fixtureGroups);
  return { root, plan, all: fixtureGroups.map((group) => group.id) };
}

test("test ownership: private source and transitive project imports select their consumers", (t) => {
  const { root, plan } = fixture(t);
  assert.deepEqual([...importedTestProjects(root, "test/backend.test.ts", testProjects(root))].sort(), ["@fixture/shared", "backend"]);
  assert.deepEqual([...projectClosure(["backend"], testProjects(root))].sort(), ["@fixture/one", "@fixture/shared", "backend"]);
  assert.deepEqual(plan(["packages/one/src/private.ts"]).groups, ["package", "backend", "architecture", "build"]);
  assert.deepEqual(plan(["packages/shared/src/index.ts"]).groups, ["package", "backend", "web", "architecture", "build"]);
  assert.deepEqual(plan(["web/src/view.ts"]).groups, ["web", "architecture", "build"]);
});

test("test ownership: cross-project import additions fall back fully until metadata is corrected", (t) => {
  const { root, plan, all } = fixture(t);
  put(root, "test/package.test.ts", 'import "../web/src/view.ts";');
  const selected = plan(["web/src/view.ts"]);
  assert.deepEqual(selected.groups, all);
  assert.match(selected.fallback.join("\n"), /package.test.ts.*needs @fixture\/web/);
  const corrected = fixtureGroups.map((group) => group.id === "package" ? { ...group, projects: [...group.projects, "@fixture/web"] } : group);
  assert.deepEqual(affectedTestGroups(root, ["web/src/view.ts"], corrected).groups, ["package", "web", "architecture", "build"]);
});

test("test ownership: computed imports require conservative coverage of every production project", (t) => {
  const { root, plan, all } = fixture(t);
  put(root, "test/package.test.ts", 'const target = "../web/src/view.ts"; await import(target);');
  const selected = plan(["web/src/view.ts"]);
  assert.deepEqual(selected.groups, all);
  assert.match(selected.fallback.join("\n"), /needs @fixture\/web/);
  assert.match(selected.fallback.join("\n"), /needs backend/);
});

test("test ownership: shared helpers, including new and deleted helpers, select every group", (t) => {
  const { root, plan, all } = fixture(t);
  for (const file of ["test/support/inner.ts", "test/support/new.ts", "scripts/test-groups.ts", "package-lock.json"]) {
    assert.deepEqual(plan([file]).groups, all, file);
  }
  rmSync(join(root, "test/support/inner.ts"));
  const deleted = plan(["test/support/inner.ts"]);
  assert.deepEqual(deleted.groups, all);
  assert.match(deleted.fallback.join("\n"), /Cannot verify test dependencies/);
});

test("test ownership: filesystem scans run for source additions, removals and unrelated repository files", (t) => {
  const { root, plan, all } = fixture(t);
  assert.equal(importedTestProjects(root, "test/scan.test.ts", testProjects(root)).size, 0, "filesystem reads have no import edge");
  put(root, "packages/one/src/new.ts", "export {};\n");
  for (const file of ["packages/one/src/new.ts", "packages/one/src/deleted.ts", "src/new.ts", "src/deleted.ts", "web/src/deleted.ts"]) {
    const selected = plan([file]);
    assert.ok(selected.groups.includes("architecture"), file);
    assert.ok(selected.groups.includes("build"), file);
    assert.equal(selected.fallback.length, 0, file);
  }
  assert.deepEqual(plan(["README.md"]).groups, all);
  assert.deepEqual(plan(["packages/new/src/index.ts"]).groups, all);
  put(root, "packages/new/project.json", JSON.stringify({ name: "@fixture/new", implicitDependencies: [] }));
  assert.deepEqual(plan(["packages/new/src/index.ts"]).groups, all);
  assert.match(plan(["packages/new/src/index.ts"]).fallback.join("\n"), /no test dependency owner/);
  assert.deepEqual(plan(["packages/one/tsconfig.json"]).groups, all);
  assert.deepEqual(plan(null).groups, all);
});

test("test ownership: unresolved private sources and unreadable graph inputs fail closed", (t) => {
  const { root, plan, all } = fixture(t);
  rmSync(join(root, "packages/one/src/private.ts"));
  assert.deepEqual(plan(["packages/one/src/private.ts"]).groups, all);
  assert.match(plan(["packages/one/src/private.ts"]).fallback.join("\n"), /Unresolved test dependency/);
  put(root, "packages/one/src/private.ts", "export {};\n");
  put(root, "web/project.json", "invalid json");
  assert.deepEqual(plan(["web/src/view.ts"]).groups, all);
  assert.match(plan(["web/src/view.ts"]).fallback.join("\n"), /Cannot verify test dependencies/);
});

test("test ownership: an added/unclassified suite is executed by the full fallback with diagnostics", (t) => {
  const { root, plan, all } = fixture(t);
  put(root, "test/new.test.ts", "export {};\n");
  put(root, "test/support/not-a-root.test.ts", "export {};\n");
  const selected = plan(["test/new.test.ts"]);
  assert.deepEqual(selected.groups, all);
  assert.match(selected.fallback.join("\n"), /Unassigned suite: test\/new.test.ts/);
  assert.equal(selected.suites.filter((suite) => suite === "test/new.test.ts").length, 1);
  assert.equal(suiteCatalog(rootSuites(root), fixtureGroups).owners["test/new.test.ts"], "unclassified");
  assert.ok(!selected.suites.includes("test/support/not-a-root.test.ts"));
  assert.deepEqual(testPlan(root, ["web"], fixtureGroups).suites, selected.suites);
});

test("test ownership: deletions and renames invalidate the catalog instead of silently shrinking a group", (t) => {
  const { root, plan, all } = fixture(t);
  rmSync(join(root, "test/package.test.ts"));
  put(root, "test/renamed.test.ts", "export {};\n");
  const selected = plan(["test/package.test.ts", "test/renamed.test.ts"]);
  assert.deepEqual(selected.groups, all);
  assert.match(selected.fallback.join("\n"), /Deleted or missing suite: test\/package.test.ts/);
  assert.match(selected.fallback.join("\n"), /Unassigned suite: test\/renamed.test.ts/);
  assert.ok(selected.suites.includes("test/renamed.test.ts"));
  assert.ok(!selected.suites.includes("test/package.test.ts"));
});

test("test ownership: duplicate ownership and invalid requests fail instead of running partial work", (t) => {
  const { root } = fixture(t);
  assert.throws(() => suiteCatalog(rootSuites(root), [...fixtureGroups, { ...fixtureGroups[0]!, id: "duplicate" }]), /Duplicate test owner/);
  assert.throws(() => suiteCatalog(rootSuites(root), [...fixtureGroups, fixtureGroups[0]!]), /Duplicate test group/);
  assert.throws(() => testPlan(root, ["typo"], fixtureGroups), /Unknown test group/);
  assert.throws(() => testPlan(root, [], fixtureGroups), /at least one/);
  for (const file of rootSuites(root)) rmSync(join(root, file));
  assert.throws(() => testPlan(root, undefined, fixtureGroups), /No root test suites/);
});

test("test ownership: no change is an explicit empty selection; actual repository helper changes are global", () => {
  assert.deepEqual(affectedTestGroups(root, []).groups, []);
  assert.deepEqual(affectedTestGroups(root, ["test/support/imports.ts"]).groups, ids);
  assert.deepEqual(affectedTestGroups(root, ["test/support/fixtures.ts"]).groups, ids);
  assert.deepEqual(affectedTestGroups(root, ["src/core/store.ts"]).fallback, []);
  for (const file of ["src/core/store.ts", "web/src/App.tsx", "packages/agent-policy/src/denied.ts", "packages/backend-runtime/src/ids.ts"]) {
    const selected = affectedTestGroups(root, [file]);
    assert.ok(selected.groups.includes("architecture"), file);
    assert.ok(selected.groups.includes("build"), file);
  }
});
