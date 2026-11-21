import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { affectedTypecheckProjects, consumersOf } from "../scripts/affected-typecheck.ts";
import { changedPaths, gitIn, type Git } from "../scripts/changes.ts";
import { NX_FLAGS, nxEnvironment, runTask, taskArguments, UsageError, type TaskArgs, type TaskHost } from "../scripts/tasks.ts";
import { rootSuites } from "../scripts/test-ownership.ts";
import { checkProjects, projectForPath, testProjects } from "../scripts/test-projects.ts";
import { temporaryRoot } from "./support/fixtures.ts";
import { sh } from "./support/git.ts";

const root = join(import.meta.dirname, "..");
const PACKAGES = testProjects(root).filter((project) => project.root.startsWith("packages/")).map((project) => project.name);
const CHECKS = checkProjects(root).map((project) => project.name);
const ALL = [...testProjects(root).map((project) => project.name), ...CHECKS];

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

test("affected typecheck: contracts select every downstream package, backend, web and all consuming partitions", () => {
  const projects = selected(["packages/contracts/src/task.ts"]);
  for (const name of ["@crane/contracts", "@crane/agent-protocol", "@crane/agent-policy", "@crane/agent-drivers", "@crane/backend-runtime", "@crane/web", "backend", ...CHECKS]) {
    assert.ok(projects.includes(name), name);
  }
  assert.ok(!projects.includes("@crane/diagnostics"));
  assert.ok(!projects.includes("@crane/worktree-deps"));
});

test("affected typecheck: isolated changes omit unrelated projects and report their consumers", () => {
  const leafChecks = ["checks-agents", "checks-cli", "checks-factory", "checks-http", "checks-storage", "checks-support", "checks-tooling", "checks-web-http"];
  assert.deepEqual(selected(["packages/diagnostics/src/index.ts"]).sort(),
    ["@crane/agent-drivers", "@crane/diagnostics", "@crane/factory", "@crane/http-server", "@crane/worktree-deps", "backend", ...leafChecks]);
  assert.deepEqual(selected(["packages/agent-policy/src/denied.ts"]).sort(), ["@crane/agent-drivers", "@crane/agent-policy", "@crane/factory", "@crane/http-server", "backend", ...CHECKS]);
  assert.deepEqual(selected(["web/src/App.tsx"]).sort(), ["@crane/web", "checks-web", "checks-web-http"]);
  assert.deepEqual(selected(["packages/storage/src/store.ts"]).sort(), ["@crane/factory", "@crane/http-server", "@crane/storage", "backend", ...leafChecks.slice(1)]);
  assert.deepEqual(selected(["packages/backend-runtime/src/ids.ts"]).sort(), ["@crane/backend-runtime", "@crane/factory", "@crane/http-server", "@crane/storage", "backend", ...leafChecks.slice(1)]);
  assert.deepEqual(selected(["packages/http-server/src/body.ts"]).sort(), ["@crane/http-server", "backend", "checks-cli", "checks-http", "checks-support", "checks-tooling", "checks-web-http"]);
  assert.deepEqual(selected(["src/cli/ui.ts"]).sort(), ["backend", "checks-cli"]);
  assert.deepEqual(selected(["test/tasks.test.ts", "scripts/test-groups.ts"]), ["checks-support", "checks-tooling"]);
  const selection = affectedTypecheckProjects(root, ["packages/agent-policy/src/denied.ts", "docs/nx.md"]);
  assert.ok(!selection.full);
  if (!selection.full) {
    assert.deepEqual(selection.changed, ["@crane/agent-policy"]);
    assert.deepEqual([...selection.consumers].sort(), ["@crane/agent-drivers", "@crane/factory", "@crane/http-server", "backend", ...CHECKS]);
    assert.deepEqual(selection.ignored, ["docs/nx.md"]);
  }
  assert.deepEqual([...consumersOf(CHECKS, [...testProjects(root), ...checkProjects(root)])], [], "nothing consumes a partition as a hub");
});

test("affected typecheck: virtual ownership and shared inputs are placed independently of physical roots", () => {
  assert.deepEqual(selected(["test/report.test.ts"]), ["checks-agents"]);
  assert.deepEqual(selected(["test/support/auth-e2e.ts"]), ["checks-cli"]);
  assert.deepEqual(selected(["test/support/api-client.ts"]), ["checks-cli", "checks-http", "checks-support"]);
  assert.deepEqual(selected(["scripts/fixture/activity-review.browser.js"]), ["checks-support"]);
  assert.deepEqual(selected(["src/application.ts"]),
    ["backend", "checks-cli", "checks-factory", "checks-http", "checks-storage", "checks-support", "checks-tooling", "checks-web-http"]);
  const parent = { name: "parent", root: "test", dependencies: [] };
  const child = { name: "child", root: "test/support", dependencies: [] };
  assert.equal(projectForPath("test/support/input.ts", [parent, child]), "child");
});

test("affected typecheck: shared inputs, project configuration, unknown files and no inputs select everything", () => {
  for (const paths of [
    ["package.json"], ["package-lock.json"], ["nx.json"], ["tsconfig.json"], ["scripts/check-workspace-links.mjs"],
    ["scripts/build.mjs"], ["packages/contracts/project.json"], ["web/package.json"], ["packages/diagnostics/tsconfig.json"],
    ["bin/crane.js"], ["packages/new/src/index.ts"], ["docs/nx.md"], ["web/src/App.tsx", "README.md", "unknown.txt"],
    ["test/unassigned.test.ts"], ["test/support/ambient.d.mts"], ["test/typecheck/http/tsconfig.json"],
  ]) {
    const selection = affectedTypecheckProjects(root, paths);
    assert.equal(selection.full, true, paths.join(", "));
    assert.ok(selection.full && selection.reasons.length > 0);
  }
  assert.deepEqual(affectedTypecheckProjects(root, null), { full: true, reasons: ["Changed files are unavailable"] });
});

/** A host that records each step, with git answering as a branch that changed `paths`. */
function host(options: { paths?: string[] | null; links?: number; nx?: number; suites?: number; root?: string } = {}) {
  const steps: string[] = [];
  const logs: string[] = [];
  const printed: string[] = [];
  const executions: (readonly string[])[] = [];
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
    root: options.root ?? root, git,
    checkLinks: () => { steps.push("links"); return options.links ?? 0; },
    nx: async (args, observeStdout) => {
      steps.push(`nx ${args.join(" ")}`);
      observeStdout?.("Nx read the output from the cache instead of running the command for 4 out of ");
      observeStdout?.("10 tasks.\n");
      return options.nx ?? 0;
    },
    runSuites: async (suites) => {
      executions.push(suites);
      steps.push(`suites ${suites.length}`);
      return options.suites ?? 0;
    },
    log: (message) => logs.push(message),
    print: (text) => printed.push(text),
  };
  return { fake, steps, logs, printed, executions };
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
  assert.deepEqual(run.executions, [rootSuites(root)]);
  assert.match(run.logs.join("\n"), /Test execution: \d+ ms wall time/);
  assert.match(run.logs.at(-1)!, /Package build: \d+ ms wall time \(exit 0, Nx cache 4\/10 hits\)/);
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
  assert.match(build.logs.at(-1)!, /Package build: \d+ ms wall time \(exit 3,/);
  assert.equal(await runTask(args(["test"]), host({ suites: 5 }).fake), 5);
  const selected = host({ nx: 3, paths: ["src/cli/ui.ts"] });
  assert.equal(await runTask(args(affected("test")), selected.fake), 3);
  assert.deepEqual(selected.executions, []);
  assert.equal(await runTask(args(affected("test")), host({ suites: 9, paths: ["src/cli/ui.ts"] }).fake), 9);
});

test("tasks: affected typecheck runs the changed projects and their consumers, with diagnostics", async () => {
  const run = host({ paths: ["packages/contracts/src/task.ts"] });
  assert.equal(await runTask(args(affected("typecheck")), run.fake), 0);
  const nx = run.steps[1]!;
  for (const name of ["@crane/contracts", "@crane/agent-drivers", "@crane/web", "backend", ...CHECKS]) assert.match(nx, new RegExp(`-p \\S*${name}`));
  assert.doesNotMatch(nx, /@crane\/diagnostics/);
  const log = run.logs.join("\n");
  assert.match(log, /Changed files \(1\): packages\/contracts\/src\/task.ts/);
  assert.match(log, /Changed projects: @crane\/contracts/);
  const consumers = /Dependent consumers: (.*)/.exec(log)?.[1]?.split(", ").sort();
  assert.deepEqual(consumers, ["@crane/agent-drivers", "@crane/agent-policy", "@crane/agent-protocol", "@crane/backend-runtime", "@crane/factory", "@crane/http-server", "@crane/storage", "@crane/web", "backend", ...CHECKS]);
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

test("tasks: repeated CLI-only checks execute the same suites even when the package build reports cache hits", async () => {
  const run = host({ paths: ["src/cli/ui.ts"] });
  const request = args(affected("test"));
  for (let index = 0; index < 2; index++) assert.equal(await runTask(request, run.fake), 0);
  assert.equal(run.executions.length, 2);
  assert.deepEqual(run.executions[0], run.executions[1]);
  assert.ok(run.executions[0]!.includes("test/cli.test.ts"));
  assert.ok(run.executions[0]!.includes("test/auth-e2e.test.ts"));
  assert.ok(!run.executions[0]!.includes("test/goals.test.ts"));
  assert.ok(run.executions[0]!.length < 106);
  assert.deepEqual(run.steps, [
    "links", `nx run-many -t build -p ${PACKAGES.join(",")} ${NX_FLAGS.join(" ")}`, `suites ${run.executions[0]!.length}`,
    "links", `nx run-many -t build -p ${PACKAGES.join(",")} ${NX_FLAGS.join(" ")}`, `suites ${run.executions[0]!.length}`,
  ]);
});

test("tasks: an unreadable selection graph still sends the full plan through the prerequisite build", async (t) => {
  const dir = temporaryRoot(t, "crane-affected-graph-");
  const put = (file: string, value: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), value);
  };
  put("packages/a/package.json", '{"name":"@fixture/a"}');
  put("packages/a/project.json", "invalid json");
  const suites = rootSuites(root);
  for (const suite of suites) put(suite, "");
  const run = host({ root: dir, paths: ["packages/a/src/index.ts"] });
  assert.equal(await runTask(args(affected("test")), run.fake), 0);
  assert.match(run.logs.join("\n"), /Full test run: Cannot verify test dependencies/);
  assert.deepEqual(run.steps, ["links", `nx run-many -t build -p @fixture/a ${NX_FLAGS.join(" ")}`, `suites ${suites.length}`]);
  assert.deepEqual(run.executions, [suites]);
});

test("tasks: --list prints the selection without checking links, building or running", async () => {
  const run = host({ paths: ["web/src/App.tsx"] });
  assert.equal(await runTask(args([...affected("typecheck"), "--list"]), run.fake), 0);
  assert.deepEqual(run.steps, []);
  const listed = JSON.parse(run.printed[0]!);
  assert.deepEqual([listed.full, listed.projects.sort()], [false, ["@crane/web", "checks-web", "checks-web-http"]]);
  assert.ok(ALL.length > listed.projects.length);
});

test("tasks: Nx keeps its cache and database in the checkout, overriding inherited locations and remote caches", () => {
  const inherited: NodeJS.ProcessEnv = {
    PATH: "/bin",
    NX_DAEMON: "true",
    NX_TUI: "true",
    NX_CACHE_DIRECTORY: "/shared/nx-cache",
    NX_WORKSPACE_DATA_DIRECTORY: "/shared/nx-data",
    NX_PROJECT_GRAPH_CACHE_DIRECTORY: "/shared/nx-graph",
    NX_SELF_HOSTED_REMOTE_CACHE_SERVER: "https://cache.example",
  };
  const env = nxEnvironment("/work/t-1", inherited);
  assert.deepEqual(env, {
    PATH: "/bin",
    NX_DAEMON: "false",
    NX_NO_CLOUD: "true",
    NX_TUI: "false",
    NX_SKIP_REMOTE_CACHE: "true",
    NX_CACHE_DIRECTORY: join("/work/t-1", ".nx", "cache"),
    NX_WORKSPACE_DATA_DIRECTORY: join("/work/t-1", ".nx", "workspace-data"),
  });
  assert.equal(inherited.NX_CACHE_DIRECTORY, "/shared/nx-cache", "the caller's environment is left alone");
  assert.notEqual(nxEnvironment("/work/t-2", inherited).NX_CACHE_DIRECTORY, env.NX_CACHE_DIRECTORY, "worktrees never share");
});
