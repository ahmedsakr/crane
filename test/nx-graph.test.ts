import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toolchain } from "../scripts/nx-toolchain.mjs";

/**
 * Nx's project graph and target contract (docs/nx.md), checked from the files
 * Nx reads. These tests don't start Nx: they pin what it is given, so a new
 * package, dependency or script can't drift out of the graph unnoticed.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

type Target = {
  executor: string;
  options?: { command?: string; cwd?: string };
  dependsOn?: (string | { projects: string[]; target: string })[];
  inputs?: (string | Record<string, string | string[]>)[];
  outputs?: string[];
  cache?: boolean;
};
type Project = { name: string; implicitDependencies: string[]; tags: string[]; targets: Record<string, Target> };

const packageDirs = readdirSync(join(root, "packages")).filter((dir) => existsSync(join(root, "packages", dir, "package.json")));
const PACKAGES = packageDirs.map((dir) => `@crane/${dir}`).sort();
/** Every project's root, by stable name. Nothing lives at the workspace root. */
const ROOTS: Record<string, string> = {
  ...Object.fromEntries(packageDirs.map((dir) => [`@crane/${dir}`, `packages/${dir}`])),
  "@crane/web": "web",
  backend: "src",
  checks: "test",
};
const projects: Record<string, Project> = Object.fromEntries(
  Object.entries(ROOTS).map(([name, dir]) => [name, readJson(`${dir}/project.json`)]),
);
const nx = readJson("nx.json");
const LINK_CHECK = /^node (\.\.\/)?scripts\/check-workspace-links\.mjs && /;

const craneDeps = (manifest: { dependencies?: Record<string, string> }) =>
  Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@crane/")).sort();

function projectFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ["node_modules", "dist", ".git", ".nx"].includes(entry.name) || entry.name.startsWith(".crane") ? [] : projectFiles(join(dir, entry.name));
    }
    return entry.name === "project.json" ? [join(dir, entry.name)] : [];
  });
}

test("nx: the graph has exactly the seven packages, web, backend and checks", () => {
  assert.equal(PACKAGES.length, 7);
  assert.deepEqual(projectFiles(".").sort(), Object.values(ROOTS).map((dir) => join(dir, "project.json")).sort(), "no other project.json");
  for (const [name, project] of Object.entries(projects)) assert.equal(project.name, name, `${ROOTS[name]}/project.json`);
  // Nx makes the root package.json a project only for an `nx` field or a project.json beside it.
  // Without one, the root manifest can't become a hub every project depends on.
  assert.equal(existsSync(join(root, "project.json")), false);
  assert.equal(readJson("package.json").nx, undefined);
  for (const dir of [...packageDirs.map((d) => `packages/${d}`), "web"]) {
    const manifest = readJson(`${dir}/package.json`);
    assert.equal(manifest.nx, undefined, `${dir} configures Nx in project.json only`);
    assert.equal(manifest.name, projects[manifest.name]?.name, `${dir}: project name is the package name`);
  }
});

test("nx: dependency edges match manifests and TypeScript references", () => {
  for (const dir of packageDirs) {
    const name = `@crane/${dir}`;
    const { references = [] } = readJson(`packages/${dir}/tsconfig.json`);
    const referenced = references.map((ref: { path: string }) => `@crane/${relative(join(root, "packages"), resolve(root, "packages", dir, ref.path))}`).sort();
    assert.deepEqual(projects[name]!.implicitDependencies, craneDeps(readJson(`packages/${dir}/package.json`)), `${name} manifest`);
    assert.deepEqual(projects[name]!.implicitDependencies, referenced, `${name} references`);
  }
  assert.deepEqual(projects["@crane/web"]!.implicitDependencies, craneDeps(readJson("web/package.json")));
  assert.deepEqual(projects.backend!.implicitDependencies, craneDeps(readJson("package.json")), "the root manifest is the backend's");
  assert.deepEqual(projects.checks!.implicitDependencies, Object.keys(ROOTS).filter((name) => name !== "checks").sort(), "suites import everything");
});

test("nx: the graph is acyclic and every edge names a project", () => {
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: string[]) => {
    assert.ok(name in projects, `${path.join(" → ")} names an unknown project ${name}`);
    assert.notEqual(state.get(name), "visiting", `cycle: ${[...path, name].join(" → ")}`);
    if (state.get(name) === "done") return;
    state.set(name, "visiting");
    for (const dep of projects[name]!.implicitDependencies) visit(dep, [...path, name]);
    state.set(name, "done");
  };
  for (const name of Object.keys(projects)) visit(name, []);
  assert.ok(!Object.values(projects).some((p) => p.implicitDependencies.includes("checks")), "nothing depends on the suites");
});

test("nx: targets follow the contract in docs/nx.md", () => {
  const expected: Record<string, string[]> = Object.fromEntries(Object.keys(ROOTS).map((name) => [name, ["build", "typecheck"]]));
  expected.checks = ["test", "typecheck"];
  for (const [name, project] of Object.entries(projects)) {
    assert.deepEqual(Object.keys(project.targets).sort(), expected[name], name);
    for (const [targetName, target] of Object.entries(project.targets)) {
      const id = `${name}:${targetName}`;
      if (target.executor === "nx:noop") {
        assert.deepEqual(target.dependsOn, ["build"], `${id}: a package build is its type check`);
        continue;
      }
      assert.equal(target.executor, "nx:run-commands", id);
      assert.match(target.options?.command ?? "", LINK_CHECK, `${id} keeps the workspace link preflight`);
      assert.equal(typeof target.cache, "boolean", `${id} states whether it caches`);
      assert.ok(target.inputs?.includes("default") || target.inputs?.includes("sharedGlobals"), `${id} hashes the shared globals`);
    }
  }
  for (const name of [...PACKAGES, "@crane/web", "backend"]) {
    const outputs = projects[name]!.targets.build!.outputs ?? [];
    assert.ok(outputs.length === 1 && outputs[0]!.endsWith("/dist"), `${name}:build outputs only its ignored dist`);
  }
  assert.equal(projects.checks!.targets.test!.cache, false, "test results are never replayed");
  assert.deepEqual(projects.checks!.targets.test!.inputs, ["{workspaceRoot}/**/*", "sharedGlobals"], "every file can affect the suites");
});

test("nx: targets run the same commands as the public npm scripts", () => {
  const { scripts } = readJson("package.json");
  const web = readJson("web/package.json").scripts;
  const command = (name: string, target: string) => projects[name]!.targets[target]!.options!.command!.replace(LINK_CHECK, "");
  for (const dir of packageDirs) {
    assert.equal(readJson(`packages/${dir}/package.json`).scripts.build, "tsc -b tsconfig.json", dir);
    assert.equal(command(`@crane/${dir}`, "build"), `tsc -b packages/${dir}/tsconfig.json`, dir);
  }
  assert.equal(command("backend", "build"), scripts["build:backend"]);
  assert.equal(command("@crane/web", "build"), web.build);
  assert.equal(command("@crane/web", "typecheck"), web.typecheck);
  assert.equal(command("backend", "typecheck"), "tsc -p tsconfig.json --noEmit");
  assert.equal(command("checks", "typecheck"), "tsc -p tsconfig.test.json");
  // The full runner over every root suite, never `npm test`, which would start Nx again.
  assert.equal(command("checks", "test"), "node --import tsx scripts/run-test-groups.ts --full");
});

test("nx: public scripts reach Nx only through scripts/tasks.ts, and no target starts npm or Nx", () => {
  const { scripts } = readJson("package.json");
  assert.equal(scripts.typecheck, "node --import tsx scripts/tasks.ts typecheck");
  assert.equal(scripts.test, "node --import tsx scripts/tasks.ts test");
  assert.equal(scripts["affected:typecheck"], "node --import tsx scripts/tasks.ts affected typecheck");
  assert.equal(scripts["affected:test"], "node --import tsx scripts/tasks.ts affected test");
  for (const lifecycle of ["pretypecheck", "posttypecheck", "pretest", "posttest"]) {
    assert.equal(scripts[lifecycle], undefined, `${lifecycle} would repeat the work scripts/tasks.ts schedules`);
  }
  const web = readJson("web/package.json").scripts;
  for (const [name, body] of Object.entries({ ...scripts, ...web })) {
    if (!name.startsWith("affected:") && !["typecheck", "test"].includes(name)) assert.doesNotMatch(String(body), /\bnx\b|scripts\/tasks\.ts/, name);
  }
  for (const [name, project] of Object.entries(projects)) {
    for (const [targetName, target] of Object.entries(project.targets)) {
      assert.doesNotMatch(target.options?.command ?? "", /\bnpm\b|\bnx\b|scripts\/tasks\.ts/, `${name}:${targetName} is not recursive`);
    }
  }
});

test("nx: only deterministic package builds and typechecks cache; bundles and suites always run", () => {
  for (const name of PACKAGES) assert.equal(projects[name]!.targets.build!.cache, true, `${name}:build restores dist with its build info`);
  for (const name of ["backend", "@crane/web", "checks"]) assert.equal(projects[name]!.targets.typecheck!.cache, true, name);
  // Staleness checks (backend-runtime/webbuild.ts) read these outputs' mtimes, which a cache restore can leave behind.
  assert.equal(projects.backend!.targets.build!.cache, false);
  assert.equal(projects["@crane/web"]!.targets.build!.cache, false);
  assert.equal(projects.checks!.targets.test!.cache, false);
  for (const dir of packageDirs) {
    const { compilerOptions } = readJson(`packages/${dir}/tsconfig.json`);
    assert.equal(compilerOptions.tsBuildInfoFile, "dist/tsconfig.tsbuildinfo", `${dir}: composite build state is inside the cached output`);
    assert.equal(compilerOptions.outDir, "dist", dir);
  }
});

test("nx: shared inputs cover lockfile, manifests, configs, task scripts and environment", () => {
  const globals = nx.namedInputs.sharedGlobals as (string | Record<string, string>)[];
  const rootConfigs = readdirSync(root).filter((f) => /^tsconfig.*\.json$/.test(f) || ["package.json", "package-lock.json", "nx.json"].includes(f));
  const used = Object.values(projects).flatMap((p) => Object.values(p.targets))
    .flatMap((t) => [...(t.options?.command ?? "").matchAll(/scripts\/[\w-]+\.mjs/g)].map((m) => m[0]));
  for (const file of [...rootConfigs, "scripts/build.mjs", "scripts/nx-toolchain.mjs", ...used]) {
    assert.ok(globals.includes(`{workspaceRoot}/${file}`), `sharedGlobals has ${file}`);
  }
  assert.ok(globals.some((input) => typeof input === "object" && input.runtime === "node scripts/nx-toolchain.mjs"), "toolchain probe");
  for (const env of ["NODE_OPTIONS", "NODE_ENV"]) assert.ok(globals.some((input) => typeof input === "object" && input.env === env), env);
  assert.deepEqual(nx.namedInputs.default, ["{projectRoot}/**/*", "sharedGlobals"]);
  assert.ok(!globals.some((input) => typeof input === "object" && "externalDependencies" in input), "every installed package stays hashed");
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.nx\/$/m, "the local cache is never committed");
});

test("nx: execution stays local, without the daemon, Cloud or plugins", () => {
  assert.equal(nx.useDaemonProcess, false);
  assert.equal(nx.neverConnectToCloud, true);
  assert.equal(nx.cacheDirectory, ".nx/cache", "relative, so each checkout and worktree keeps its own");
  for (const key of ["nxCloudId", "nxCloudAccessToken", "nxCloudUrl", "tasksRunnerOptions", "plugins", "targetDefaults"]) {
    assert.equal(nx[key], undefined, `nx.json has no ${key}`);
  }
});

/**
 * Asks the installed Nx where its cache and task database go for this checkout.
 * Nx 24 otherwise shares both between every checkout of a repo under `~/.nx/<id>`,
 * and every worktree of a repo has the same id. Loading the module resolves (and
 * for a shared location creates) the directories, so HOME points somewhere disposable.
 */
const NX_LOCATIONS = `const m = require(process.argv[1]);
console.log(JSON.stringify({ cache: m.cacheDir, db: m.sharedDataDirectory(process.cwd(), "workspace-data") }));`;

test("nx: the cache and task database stay in this checkout's ignored .nx, never shared under HOME", (t) => {
  const home = mkdtempSync(join(tmpdir(), "crane-nx-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const name of ["NX_CACHE_DIRECTORY", "NX_WORKSPACE_DATA_DIRECTORY", "NX_PROJECT_GRAPH_CACHE_DIRECTORY"]) delete env[name];
  const resolver = join(root, "node_modules", "nx", "dist", "src", "utils", "cache-directory.js");
  assert.ok(existsSync(resolver), "Nx moved its cache resolver: find the new one and keep this check");
  const run = spawnSync(process.execPath, ["-e", NX_LOCATIONS, resolver], { cwd: root, env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { cache: join(root, ".nx", "cache"), db: join(root, ".nx", "workspace-data") });
  assert.deepEqual(readdirSync(home), [], "nothing under HOME");
});

test("nx: npm installs a pinned Nx that brings no other compiler or plugin", () => {
  const manifest = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.match(manifest.devDependencies.nx, /^\d+\.\d+\.\d+$/, "pinned exactly");
  assert.equal(lock.packages["node_modules/nx"].version, manifest.devDependencies.nx);
  assert.equal(manifest.packageManager, undefined, "npm stays the package manager");
  for (const other of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) assert.equal(existsSync(join(root, other)), false, other);
  const nxPackages = Object.keys(lock.packages).filter((path) => /(^|\/)node_modules\/@nx\//.test(path));
  assert.deepEqual(nxPackages.filter((path) => !/@nx\/nx-[\w-]+$/.test(path)), [], "only Nx's native binaries, no @nx plugins");
  assert.equal(lock.packages["node_modules/nx"].dependencies?.typescript, undefined);
});

test("nx: the toolchain probe reports installed tools and broken links", (t) => {
  const here = toolchain(root);
  assert.equal(here.node, process.version);
  assert.equal(here.platform, process.platform);
  assert.match(here.typescript ?? "", /^7\./);
  assert.equal(here.nx, readJson("package.json").devDependencies.nx);
  assert.equal(here.workspaceLinks, "ok");

  const dir = mkdtempSync(join(tmpdir(), "crane-nx-toolchain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(toolchain(dir).typescript, "missing");
  assert.match(toolchain(dir).workspaceLinks ?? "", /^unchecked: /);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["a"] }));
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "a", "package.json"), JSON.stringify({ name: "@fixture/a" }));
  assert.equal(toolchain(dir).workspaceLinks, "invalid: @fixture/a");
});
