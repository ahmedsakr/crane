import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRule } from "@crane/contracts/rules";
import { ruleLabel } from "@crane/contracts";
import { moduleRefs, packageImportViolations, parseSource, specifiers } from "./support/imports.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("contracts preserve the complete public type and runtime export names", async () => {
  // Captured from index.ts before splitting, including main's acceptanceCheckRun addition.
  const types = `AcceptanceResult Agent AgentRun AgentState Analytics AuthStatus Autonomy BlockedCall BlockedTool CommandEvidence
CrewSchedule CrewScheduleInput DiffFile DiffHunk DiffLine DriverInfo DriverName DriverSettings EventActor EventType
Finding FollowUpSource FollowUpState Goal GoalDetail GoalListItem GoalPlan GoalProgress GoalSummary GoalTask GoalTaskPhase
InviteCheck InviteSummary Lookout LookoutInfo MaintenanceRole MaintenanceRoleInfo MergeOutcome NewGoal NewTask
OperatorProfile OperatorRole OperatorSession OperatorSummary Overview ParsedDiff PostmortemSettings
PrerequisiteState Repo RepoTools Report RetentionSettings ReviewCheckpoint RoleRunOptions RunKind
RunOutcome RunUsage Screenshot SpendSlice SplitRow Task TaskDetail TaskDiff TaskDraft TaskEvent TaskGates
TaskKind TaskRunOptions TaskStatus TaskSummary ValidationRun VisualReview`.split(/\s+/).sort();
  const values = `ACTIVE_STATUSES ALL_STATUSES AUTONOMY_LABEL DRIVER_LABEL DRIVER_NAMES EFFORT_LEVELS FINISHED_STATUSES
GOAL_TASK_PHASES KIND_LABEL LOOKOUT LOOKOUTS MAINTENANCE_ROLE MAINTENANCE_ROLES MAX_NAME_LENGTH MIN_PASSWORD_LENGTH
MODEL_SUGGESTIONS RUN_KIND_LABEL SHIPPED_STATUSES STATUS_LABEL UNSHIPPED_STATUSES USERNAME_PATTERN acceptanceCheckRun
acceptanceFor actorLabel choosableDrivers completionReviewReason crewScheduleLabel describeClient diffFiles driverLabel
errorMessage eventActor followUpFor goalProgress goalTaskPhase goalWaves inviteLinkPath isDriverName isEventActor isLookout
isMaintenanceRole isScheduled isTunable lastMergeOutcome lookoutsLabel nextCrewFire normalizeUsername parseDiff
prerequisiteMet ruleLabel runCostLabel runTokens settingsLabel splitRows unmetAcceptance
validateCrewSchedule validateGoalPlan visualReviewPending visualReviewWaivedByPreApproval`.split(/\s+/).sort();
  const file = join(root, "packages/contracts/src/index.ts");
  const exports = parseSource(readFileSync(file, "utf8"), file).program.body;
  const named = exports.filter((node) => node.type === "ExportNamedDeclaration");
  const names = (kind: "type" | "value") => named
    .filter((node) => node.exportKind === kind)
    .flatMap((node) => node.specifiers.map((spec) => {
      assert.ok(spec.exported.type === "Identifier");
      return spec.exported.name;
    })).sort();
  assert.equal(named.length, exports.length, "only explicit named exports");
  assert.deepEqual(names("type"), types);
  assert.deepEqual(names("value"), values);
  assert.deepEqual(Object.keys(await import("@crane/contracts")).sort(), values);
});

test("contract domain modules use erased imports between domains", () => {
  const domains = [
    "task.ts", "report.ts", "repo.ts", "events.ts", "crew.ts",
    "lookouts.ts", "runs.ts", "overview.ts", "drivers.ts", "merge.ts", "access.ts",
  ];
  const src = join(root, "packages/contracts/src");
  for (const file of domains) {
    assert.ok(readFileSync(join(src, file), "utf8").split("\n").length - 1 < 500, file);
    assert.ok(moduleRefs(join(src, file)).every((ref) => ref.typeOnly), file);
  }
  assert.equal(existsSync(join(src, "types.ts")), false);
});

const web = join(root, "web");
const within = (dir: string, path: string) => path === dir || path.startsWith(dir + sep);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Every workspace package. A directory with no manifest is a leftover from another branch, not a package. */
const packages = readdirSync(join(root, "packages"))
  .filter((dir) => existsSync(join(root, "packages", dir, "package.json")))
  .map((dir) => {
    const path = join(root, "packages", dir);
    return { dir, path, manifest: readJson(join(path, "package.json")) };
  });

/** Entry points a package exposes beyond `.`, which every package has. */
const EXTRA_ENTRY_POINTS: Record<string, string[]> = { "@crane/contracts": ["rules"] };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", ".git"].includes(name)) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.[cm]?[jt]sx?$/.test(name) ? [p] : [];
  });
}

const workspace = (file: string) => [...packages.map((p) => p.path), web].find((dir) => within(dir, file)) ?? root;

test("every package is packaged the same way and ships in the root tarball", async (t) => {
  const rootManifest = readJson(join(root, "package.json"));
  const graph = readJson(join(root, "tsconfig.packages.json"));
  assert.deepEqual(graph.files, [], "solution config compiles only referenced projects");
  assert.deepEqual(
    graph.references.map((ref: { path: string }) => resolve(root, ref.path)).sort(),
    packages.map((p) => p.path).sort(),
    "build graph covers exactly packages/*",
  );
  const entry = (name: string) => ({ types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` });
  for (const { dir, path, manifest } of packages) {
    await t.test(dir, () => {
      assert.equal(manifest.name, `@crane/${dir}`);
      assert.equal(manifest.private, true, "private, versioned with Crane");
      assert.equal(manifest.type, "module");
      assert.deepEqual(manifest.files, ["dist/"]);
      const extras = EXTRA_ENTRY_POINTS[manifest.name] ?? [];
      assert.deepEqual(manifest.exports, {
        ".": entry("index"),
        ...Object.fromEntries(extras.map((name) => [`./${name}`, entry(name)])),
      });
      for (const input of ["src/index.ts", "tsconfig.json"]) {
        assert.ok(existsSync(join(path, input)), `has ${input}`);
      }
      assert.equal(rootManifest.dependencies[manifest.name], manifest.version, "pinned in root dependencies");
      assert.ok(rootManifest.bundledDependencies.includes(manifest.name), "listed in root bundledDependencies");
      assert.ok(rootManifest.workspaces.includes(`packages/${dir}`), "listed in root workspaces");
      const config = readJson(join(path, "tsconfig.json"));
      assert.equal(config.compilerOptions.composite, true, "supports project references");
      assert.ok(within(join(path, "dist"), resolve(path, config.compilerOptions.tsBuildInfoFile)), "build cache is cleaned with dist");
      assert.deepEqual(
        (config.references ?? []).map((ref: { path: string }) => resolve(path, ref.path)).sort(),
        packages.filter((p) => p.manifest.name in (manifest.dependencies ?? {})).map((p) => p.path).sort(),
        "project references match workspace dependencies",
      );
    });
  }
  assert.deepEqual(
    rootManifest.bundledDependencies.filter((name: string) => name.startsWith("@crane/")).sort(),
    packages.map((p) => p.manifest.name).sort(),
    "root bundledDependencies match packages/*",
  );
});

test("package build and watch use the same graph after workspace preflight", () => {
  const { scripts } = readJson(join(root, "package.json"));
  assert.match(scripts["build:packages"], /^node scripts\/check-workspace-links\.mjs && tsc -b tsconfig\.packages\.json$/);
  assert.equal(scripts["dev:packages"], `${scripts["build:packages"]} --watch`);
  assert.ok(scripts.dev.includes('"npm:dev:packages"'), "development runs the graph watcher");
});

test("the backend compile leaves out browser and React types", () => {
  const { lib, types } = readJson(join(root, "tsconfig.json")).compilerOptions;
  assert.deepEqual(lib, ["ES2022"], "an unset lib loads lib.dom.d.ts");
  assert.deepEqual(types, ["node"], "unset types loads every hoisted @types package, including react");
});

test("the dashboard bundles only contracts, the one package whose changes stale it", () => {
  const bad = walk(web).flatMap((file) => specifiers(file)
    .filter((spec) => spec.startsWith("@crane/") && spec !== "@crane/contracts" && !spec.startsWith("@crane/contracts/"))
    .map((spec) => `${relative(root, file)} → ${spec}`));
  assert.deepEqual(bad, []);
});

test("the import helper sees every way to load a module", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-imports-"));
  try {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "inside.ts"), "export const inside = 1;\n");
    writeFileSync(join(srcDir, "all.ts"), [
      `import { inside } from "./inside.js";`,
      `import type { A } from "types-only";`,
      `export { b } from "reexport";`,
      `export type { C } from "type-reexport";`,
      `import "../outside.js";`,
      `import x = require("import-equals");`,
      `type D = import("import-type").D;`,
      `const e = await import("dynamic");`,
      `const f = require("required");`,
      `const g = await import(inside);`,
      `// import "in-a-comment";`,
      `const h = 'import "in-a-string"';`,
    ].join("\n"));
    assert.deepEqual(moduleRefs(join(srcDir, "all.ts")), [
      { spec: "./inside.js", declaration: true, typeOnly: false },
      { spec: "types-only", declaration: true, typeOnly: true },
      { spec: "reexport", declaration: true, typeOnly: false },
      { spec: "type-reexport", declaration: true, typeOnly: true },
      { spec: "../outside.js", declaration: true, typeOnly: false },
      { spec: "import-equals", declaration: false, typeOnly: false },
      { spec: "import-type", declaration: false, typeOnly: true },
      { spec: "dynamic", declaration: false, typeOnly: false },
      { spec: "required", declaration: false, typeOnly: false },
      { spec: null, declaration: false, typeOnly: false },
    ]);
    assert.deepEqual(packageImportViolations(srcDir, (ref) => ref.spec === "types-only" || ref.spec === "reexport"), [
      `all.ts imports "type-reexport"`,
      "all.ts imports outside the package: ../outside.js",
      "all.ts loads import-equals outside an import declaration",
      "all.ts loads import-type outside an import declaration",
      "all.ts loads dynamic outside an import declaration",
      "all.ts loads required outside an import declaration",
      "all.ts loads a module outside an import declaration",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("application workspaces use package entry points, never each other's source paths", () => {
  const escapes: string[] = [];
  // Repository tests may import the implementation under test (including web helpers).
  const files = [...["src", "scripts", "web"].map((d) => join(root, d)), ...packages.map((p) => p.path)].flatMap(walk);
  for (const file of files) {
    for (const spec of specifiers(file)) {
      if (spec.startsWith(".") || isAbsolute(spec)) {
        if (workspace(file) !== workspace(resolve(dirname(file), spec))) escapes.push(`${relative(root, file)} → ${spec}`);
        continue;
      }
      const target = packages.find((p) => spec === p.manifest.name || spec.startsWith(`${p.manifest.name}/`));
      if (target && !(`.${spec.slice(target.manifest.name.length)}` in target.manifest.exports)) {
        escapes.push(`${relative(root, file)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(escapes, []);
  const config = JSON.parse(readFileSync(join(web, "tsconfig.json"), "utf8"));
  assert.deepEqual(config.include, ["src"], "web doesn't compile backend source");
  assert.equal(config.compilerOptions.paths, undefined, "no aliases around package exports");
});

test("contracts stay self-contained and browser-safe", () => {
  const contracts = join(root, "packages", "contracts");
  assert.deepEqual(packageImportViolations(join(contracts, "src"), () => false), []);
  const manifest = readJson(join(contracts, "package.json"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(Object.keys(manifest[field] ?? {}), [], `no ${field}`);
  }
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
