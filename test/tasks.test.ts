import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { affectedTypecheckProjects, consumersOf } from "../scripts/affected-typecheck.ts";
import { changedPaths, gitIn, type Git } from "../scripts/changes.ts";
import { NX_FLAGS, runTask, taskArguments, UsageError, type TaskArgs, type TaskHost } from "../scripts/tasks.ts";
import { rootSuites } from "../scripts/test-ownership.ts";
import { testProjects } from "../scripts/test-projects.ts";
import { temporaryRoot } from "./support/fixtures.ts";
import { sh } from "./support/git.ts";

const root = join(import.meta.dirname, "..");
const PACKAGES = testProjects(root).filter((project) => project.root.startsWith("packages/")).map((project) => project.name);
const ALL = testProjects(root).map((project) => project.name);

test("tasks: arguments need an explicit base and exactly one head or working tree", () => {
  assert.deepEqual(taskArguments(["typecheck"]), { kind: "typecheck", list: false });
  assert.deepEqual(taskArguments(["test", "--list"]), { kind: "test", list: true });
  assert.deepEqual(taskArguments(["affected", "test", "--base", "main", "--working-tree"]),
    { kind: "test", list: false, affected: { base: "main", head: undefined, workingTree: true } });
  assert.deepEqual(taskArguments(["affected", "typecheck", "--base", "origin/main", "--head", "HEAD", "--list"]),
    { kind: "typecheck", list: true, affected: { base: "origin/main", head: "HEAD", workingTree: false } });
  for (const argv of [
    [], ["lint"], ["typecheck", "--base", "main"], ["affected", "test"], ["affected", "test", "--working-tree"],
    ["affected", "test", "--base", "main"], ["affected", "test", "--base", "main", "--head", "HEAD", "--working-tree"],
    ["affected", "test", "--base"], ["affected", "test", "--base", "--working-tree"], ["affected", "test", "--base", "main", "--typo"],
  ]) assert.throws(() => taskArguments(argv), UsageError, argv.join(" "));
});

function repository(t: TestContext) {
  const dir = temporaryRoot(t, "crane-changes-");
  const put = (file: string, text = `${file}\n`) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  for (const file of ["keep.ts", "edit.ts", "old name.ts", "gone.ts"]) put(file);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "base");
  return { dir, put, git: gitIn(dir), head: () => sh(dir, "rev-parse", "HEAD") };
}

test("changes: committed edits, additions, deletions and both sides of a rename", (t) => {
  const { dir, put, git } = repository(t);
  sh(dir, "checkout", "-q", "-b", "task");
  put("edit.ts", "changed\n");
  put("added.ts");
  rmSync(join(dir, "gone.ts"));
  renameSync(join(dir, "old name.ts"), join(dir, "new name.ts"));
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "task");
  const found = changedPaths(git, { base: "main", head: "HEAD", workingTree: false });
  assert.ok(found.ok, JSON.stringify(found));
  assert.deepEqual(found.paths, ["added.ts", "edit.ts", "gone.ts", "new name.ts", "old name.ts"]);
  assert.match(found.description, /^main \([0-9a-f]{12}\) → HEAD \([0-9a-f]{12}\)$/);
});

test("changes: working-tree mode counts staged, unstaged, deleted and untracked files, not ignored ones", (t) => {
  const { dir, put, git } = repository(t);
  put("edit.ts", "unstaged\n");
  put("staged.ts");
  sh(dir, "add", "staged.ts");
  put("untracked/new.ts");
  put("ignored/build.ts");
  rmSync(join(dir, "gone.ts"));
  const found = changedPaths(git, { base: "main", workingTree: true });
  assert.ok(found.ok, JSON.stringify(found));
  assert.deepEqual(found.paths, ["edit.ts", "gone.ts", "staged.ts", "untracked/new.ts"]);
  assert.match(found.description, /working tree/);
});

test("changes: missing history, self-comparison and unchecked-out heads are unavailable, never empty", (t) => {
  const { dir, put, git, head } = repository(t);
  const base = head();
  const unavailable = (request: Parameters<typeof changedPaths>[1], pattern: RegExp) => {
    const found = changedPaths(git, request);
    assert.equal(found.ok, false, JSON.stringify(request));
    if (!found.ok) assert.match(found.reason, pattern);
  };
  unavailable({ base: "no-such-branch", workingTree: true }, /not a commit in this checkout's local history/);
  unavailable({ base: "0".repeat(40), workingTree: true }, /not a commit/);
  unavailable({ base: "--output=/tmp/x", workingTree: true }, /is not a revision/);
  unavailable({ base: "main", head: "HEAD", workingTree: false }, /both [0-9a-f]{12}/);
  unavailable({ base: "main", workingTree: true }, /Nothing differs/);
  sh(dir, "checkout", "-q", "-b", "task");
  put("edit.ts", "changed\n");
  sh(dir, "commit", "-q", "-am", "task");
  sh(dir, "checkout", "-q", "main");
  unavailable({ base: base, head: "task", workingTree: false }, /checkout is at .*not the head task/);
  sh(dir, "checkout", "-q", "task");
  put("local.ts");
  unavailable({ base: "main", head: "task", workingTree: false }, /1 local change.*--working-tree/);
  unavailable({ base: "main", workingTree: false }, /--head/);
  const outside = temporaryRoot(t, "crane-not-git-");
  const notGit = changedPaths(gitIn(outside), { base: "main", workingTree: true });
  assert.equal(notGit.ok, false);
  const missing: Git = () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn git ENOENT") });
  const noGit = changedPaths(missing, { base: "main", workingTree: true });
  assert.ok(!noGit.ok && /ENOENT/.test(noGit.reason));
});

const selected = (paths: string[]) => {
  const selection = affectedTypecheckProjects(root, paths);
  assert.equal(selection.full, false, JSON.stringify(selection));
  return selection.full ? [] : selection.projects;
};

test("affected typecheck: contracts select every downstream package, backend, web and checks", () => {
  const projects = selected(["packages/contracts/src/task.ts"]);
  for (const name of ["@crane/contracts", "@crane/agent-protocol", "@crane/agent-policy", "@crane/agent-drivers", "@crane/web", "backend", "checks"]) {
    assert.ok(projects.includes(name), name);
  }
  assert.ok(!projects.includes("@crane/diagnostics"));
  assert.ok(!projects.includes("@crane/worktree-deps"));
});

test("affected typecheck: isolated changes omit unrelated projects and report their consumers", () => {
  assert.deepEqual(selected(["packages/diagnostics/src/index.ts"]).sort(),
    ["@crane/agent-drivers", "@crane/diagnostics", "@crane/worktree-deps", "backend", "checks"]);
  assert.deepEqual(selected(["packages/agent-policy/src/denied.ts"]).sort(), ["@crane/agent-drivers", "@crane/agent-policy", "backend", "checks"]);
  assert.deepEqual(selected(["web/src/App.tsx"]).sort(), ["@crane/web", "checks"]);
  assert.deepEqual(selected(["src/core/store.ts"]).sort(), ["backend", "checks"]);
  assert.deepEqual(selected(["test/tasks.test.ts", "scripts/test-groups.ts"]), ["checks"]);
  const selection = affectedTypecheckProjects(root, ["packages/agent-policy/src/denied.ts", "docs/nx.md"]);
  assert.ok(!selection.full);
  if (!selection.full) {
    assert.deepEqual(selection.changed, ["@crane/agent-policy"]);
    assert.deepEqual([...selection.consumers].sort(), ["@crane/agent-drivers", "backend", "checks"]);
    assert.deepEqual(selection.ignored, ["docs/nx.md"]);
  }
  assert.deepEqual([...consumersOf(["checks"], testProjects(root))], [], "nothing consumes the suites");
});

test("affected typecheck: shared inputs, project configuration, unknown files and no inputs select everything", () => {
  for (const paths of [
    ["package.json"], ["package-lock.json"], ["nx.json"], ["tsconfig.json"], ["scripts/check-workspace-links.mjs"],
    ["scripts/build.mjs"], ["packages/contracts/project.json"], ["web/package.json"], ["packages/diagnostics/tsconfig.json"],
    ["bin/crane.js"], ["packages/new/src/index.ts"], ["docs/nx.md"], ["web/src/App.tsx", "README.md", "unknown.txt"],
  ]) {
    const selection = affectedTypecheckProjects(root, paths);
    assert.equal(selection.full, true, paths.join(", "));
    assert.ok(selection.full && selection.reasons.length > 0);
  }
  assert.deepEqual(affectedTypecheckProjects(root, null), { full: true, reasons: ["Changed files are unavailable"] });
});

/** A host that records each step, with git answering as a branch that changed `paths`. */
function host(options: { paths?: string[] | null; links?: number; nx?: number; suites?: number } = {}) {
  const steps: string[] = [];
  const logs: string[] = [];
  const printed: string[] = [];
  const commit = "a".repeat(40);
  const other = "b".repeat(40);
  const git: Git = (args) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return ok("true\n");
    if (args[0] === "rev-parse") {
      if (options.paths === null) return { status: 1, stdout: "", stderr: "" };
      return ok(`${args.at(-1)!.startsWith("main") ? other : commit}\n`);
    }
    if (args[0] === "diff") return ok((options.paths ?? []).map((path) => `${path}\0`).join(""));
    return ok("");
  };
  const fake: TaskHost = {
    root, git,
    checkLinks: () => { steps.push("links"); return options.links ?? 0; },
    nx: async (args) => { steps.push(`nx ${args.join(" ")}`); return options.nx ?? 0; },
    runSuites: async (suites) => { steps.push(`suites ${suites.length}`); return options.suites ?? 0; },
    log: (message) => logs.push(message),
    print: (text) => printed.push(text),
  };
  return { fake, steps, logs, printed };
}

const args = (argv: string[]): TaskArgs => taskArguments(argv);
const affected = (kind: string) => ["affected", kind, "--base", "main", "--head", "HEAD"];

test("tasks: full typecheck checks links outside Nx, then every project's typecheck", async () => {
  const run = host();
  assert.equal(await runTask(args(["typecheck"]), run.fake), 0);
  assert.deepEqual(run.steps, ["links", `nx run-many -t typecheck ${NX_FLAGS.join(" ")}`]);
});

test("tasks: full tests build every package before one runner over every root suite", async () => {
  const run = host();
  assert.equal(await runTask(args(["test"]), run.fake), 0);
  assert.deepEqual(run.steps, ["links", `nx run-many -t build -p ${PACKAGES.join(",")} ${NX_FLAGS.join(" ")}`, `suites ${rootSuites(root).length}`]);
});

test("tasks: a broken workspace link stops before Nx can replay anything from its cache", async () => {
  for (const argv of [["typecheck"], ["test"], affected("typecheck"), affected("test")]) {
    const run = host({ links: 1, paths: ["src/core/store.ts"] });
    assert.equal(await runTask(args(argv), run.fake), 1, argv.join(" "));
    assert.deepEqual(run.steps, ["links"], argv.join(" "));
  }
});

test("tasks: failures keep their exit status, and a failed package build runs no suite", async () => {
  assert.equal(await runTask(args(["typecheck"]), host({ nx: 7 }).fake), 7);
  const build = host({ nx: 3 });
  assert.equal(await runTask(args(["test"]), build.fake), 3);
  assert.equal(build.steps.some((step) => step.startsWith("suites")), false);
  assert.equal(await runTask(args(["test"]), host({ suites: 5 }).fake), 5);
  assert.equal(await runTask(args(affected("test")), host({ suites: 9, paths: ["src/core/store.ts"] }).fake), 9);
});

test("tasks: affected typecheck runs the changed projects and their consumers, with diagnostics", async () => {
  const run = host({ paths: ["packages/contracts/src/task.ts"] });
  assert.equal(await runTask(args(affected("typecheck")), run.fake), 0);
  const nx = run.steps[1]!;
  for (const name of ["@crane/contracts", "@crane/agent-drivers", "@crane/web", "backend", "checks"]) assert.match(nx, new RegExp(`-p \\S*${name}`));
  assert.doesNotMatch(nx, /@crane\/diagnostics/);
  const log = run.logs.join("\n");
  assert.match(log, /Changed files \(1\): packages\/contracts\/src\/task.ts/);
  assert.match(log, /Changed projects: @crane\/contracts/);
  const consumers = /Dependent consumers: (.*)/.exec(log)?.[1]?.split(", ").sort();
  assert.deepEqual(consumers, ["@crane/agent-drivers", "@crane/agent-policy", "@crane/agent-protocol", "@crane/web", "backend", "checks"]);
});

test("tasks: unavailable history and global inputs fall back to full work with an explanation", async () => {
  const history = host({ paths: null });
  assert.equal(await runTask(args(affected("typecheck")), history.fake), 0);
  assert.deepEqual(history.steps, ["links", `nx run-many -t typecheck ${NX_FLAGS.join(" ")}`]);
  assert.match(history.logs.join("\n"), /not a commit in this checkout's local history[\s\S]*Full typecheck: Changed files are unavailable/);

  const tests = host({ paths: null });
  assert.equal(await runTask(args(affected("test")), tests.fake), 0);
  assert.equal(tests.steps.at(-1), `suites ${rootSuites(root).length}`);
  assert.match(tests.logs.join("\n"), /Full test run: Changed inputs unavailable/);

  const empty = host({ paths: [] });
  await runTask(args(affected("test")), empty.fake);
  assert.equal(empty.steps.at(-1), `suites ${rootSuites(root).length}`, "an empty diff is not an empty success");
  assert.match(empty.logs.join("\n"), /Nothing differs/);

  const global = host({ paths: ["package-lock.json", "web/src/App.tsx"] });
  await runTask(args(affected("typecheck")), global.fake);
  assert.equal(global.steps.at(-1), `nx run-many -t typecheck ${NX_FLAGS.join(" ")}`);
  assert.match(global.logs.join("\n"), /Full typecheck: Shared input for every task: package-lock.json/);
});

test("tasks: affected tests run only the selected groups' suites, after every package build", async () => {
  const run = host({ paths: ["packages/agent-protocol/src/report.ts"] });
  assert.equal(await runTask(args(affected("test")), run.fake), 0);
  assert.equal(run.steps[1], `nx run-many -t build -p ${PACKAGES.join(",")} ${NX_FLAGS.join(" ")}`);
  const count = Number(run.steps[2]!.split(" ")[1]);
  assert.ok(count > 0 && count < rootSuites(root).length, run.steps[2]);
  assert.match(run.logs.join("\n"), /Test groups \(\d+\): .*package-agent-protocol/);
  assert.doesNotMatch(run.logs.join("\n"), /Test groups.*package-agent-policy/);
});

test("tasks: --list prints the selection without checking links, building or running", async () => {
  const run = host({ paths: ["web/src/App.tsx"] });
  assert.equal(await runTask(args([...affected("typecheck"), "--list"]), run.fake), 0);
  assert.deepEqual(run.steps, []);
  const listed = JSON.parse(run.printed[0]!);
  assert.deepEqual([listed.full, listed.projects.sort()], [false, ["@crane/web", "checks"]]);
  assert.ok(ALL.length > listed.projects.length);
});
