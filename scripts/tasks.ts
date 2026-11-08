import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkspaceLinks } from "./check-workspace-links.mjs";
import { changedPaths, gitIn, type ChangeRequest, type Git } from "./changes.ts";
import { runProcess, runTestSuites } from "./test-runner.ts";

/**
 * `npm run typecheck`, `npm test` and their affected variants. Full commands keep
 * full coverage: every project's typecheck target, and every root suite after the
 * package builds. Affected commands compare an explicit base with an explicit head
 * or the working tree, print what they selected and why, and fall back to the
 * full command whenever the change set or its ownership is uncertain.
 *
 * The workspace link check always runs here, outside Nx, so a cache hit can't skip it.
 * Nx runs without its daemon, Cloud or TUI. Test results are never cached.
 */

export type TaskKind = "typecheck" | "test";
export interface TaskArgs {
  kind: TaskKind;
  affected?: ChangeRequest;
  /** Print the selection and stop, without the link check, builds or checks. */
  list: boolean;
}

export const USAGE = `Usage:
  npm run typecheck                Type-check every project
  npm test                         Build the packages, then run every root suite
  npm run affected:typecheck -- --base <rev> (--head <rev> | --working-tree) [--list]
  npm run affected:test -- --base <rev> (--head <rev> | --working-tree) [--list]`;

export class UsageError extends Error {}

function option(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a revision`);
  return value;
}

/** `<typecheck|test>` or `affected <typecheck|test>`, then the comparison and `--list`. */
export function taskArguments(argv: readonly string[]): TaskArgs {
  const affected = argv[0] === "affected";
  const [kind, ...rest] = affected ? argv.slice(1) : argv;
  if (kind !== "typecheck" && kind !== "test") throw new UsageError(`Unknown task: ${String(kind)}`);
  let base: string | undefined;
  let head: string | undefined;
  let workingTree = false;
  let list = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (affected && arg === "--base") base = option(rest, index++, arg);
    else if (affected && arg === "--head") head = option(rest, index++, arg);
    else if (affected && arg === "--working-tree") workingTree = true;
    else if (arg === "--list") list = true;
    else throw new UsageError(`Unknown or misplaced argument: ${arg}`);
  }
  if (!affected) return { kind, list };
  if (!base) throw new UsageError("Affected tasks need --base <rev>: the known-good revision to compare with");
  if (Boolean(head) === workingTree) throw new UsageError("Give exactly one of --head <rev> or --working-tree");
  return { kind, list, affected: { base, head, workingTree } };
}

/** Everything a task touches outside this module, so tests can supply fakes. */
export interface TaskHost {
  root: string;
  checkLinks(): number;
  nx(args: readonly string[]): Promise<number>;
  runSuites(suites: readonly string[]): Promise<number>;
  git: Git;
  /** Diagnostics, on stderr in production. */
  log(message: string): void;
  /** The `--list` result, on stdout in production. */
  print(text: string): void;
}

/**
 * Plain, complete Nx output: failing tasks print in full, successful and cached ones in one line.
 * It also replaces the TUI (Nx refuses `--tui` with `--outputStyle`; the environment sets NX_TUI=false too).
 */
export const NX_FLAGS = ["--outputStyle=static-failures-only"];

function listFiles(files: readonly string[], limit = 20): string {
  const shown = files.slice(0, limit).join(", ");
  return files.length > limit ? `${shown}, and ${files.length - limit} more` : shown;
}

function changes(host: TaskHost, request: ChangeRequest, kind: TaskKind): string[] | null {
  const found = changedPaths(host.git, request);
  host.log(`Affected ${kind}: ${found.description ?? `${request.base} → ${request.head ?? "working tree"}`}`);
  if (!found.ok) {
    host.log(`  Changed files: unavailable. ${found.reason}`);
    return null;
  }
  host.log(`  Changed files (${found.paths.length}): ${listFiles(found.paths)}`);
  return found.paths;
}

async function typecheck(args: TaskArgs, host: TaskHost): Promise<number> {
  const links = args.list ? 0 : host.checkLinks();
  if (links) return links;
  let projects: string[] | undefined;
  if (args.affected) {
    const { affectedTypecheckProjects } = await import("./affected-typecheck.ts");
    const selection = affectedTypecheckProjects(host.root, changes(host, args.affected, "typecheck"));
    if (selection.full) {
      for (const reason of selection.reasons) host.log(`  Full typecheck: ${reason}`);
    } else {
      if (selection.ignored.length) host.log(`  Not typecheck inputs: ${listFiles(selection.ignored)}`);
      host.log(`  Changed projects: ${selection.changed.join(", ")}`);
      host.log(`  Dependent consumers: ${selection.consumers.join(", ") || "none"}`);
      host.log(`  Type-checking ${selection.projects.length} project(s): ${selection.projects.join(", ")}`);
      projects = selection.projects;
    }
  }
  const nxArgs = ["run-many", "-t", "typecheck", ...(projects ? ["-p", projects.join(",")] : []), ...NX_FLAGS];
  if (args.list) {
    host.print(JSON.stringify({ kind: "typecheck", full: !projects, projects: projects ?? "all", nx: nxArgs }, null, 2));
    return 0;
  }
  return host.nx(nxArgs);
}

async function test(args: TaskArgs, host: TaskHost): Promise<number> {
  // A stale install stops before ownership scans read any workspace source.
  const links = args.list ? 0 : host.checkLinks();
  if (links) return links;
  const { affectedTestGroups, testPlan } = await import("./test-ownership.ts");
  const { testProjects } = await import("./test-projects.ts");
  const plan = args.affected ? affectedTestGroups(host.root, changes(host, args.affected, "test")) : testPlan(host.root);
  for (const reason of plan.fallback) host.log(`  Full test run: ${reason}`);
  if (args.affected && !plan.fallback.length) {
    host.log(`  Test groups (${plan.groups.length}): ${plan.groups.join(", ")}`);
    host.log(`  Running ${plan.suites.length} suite(s)`);
  }
  // Suites may import any package's compiled output, so every package builds first.
  const packages = testProjects(host.root).filter((project) => project.root.startsWith("packages/")).map((project) => project.name);
  const nxArgs = ["run-many", "-t", "build", "-p", packages.join(","), ...NX_FLAGS];
  if (args.list) {
    host.print(JSON.stringify({ kind: "test", ...plan, nx: nxArgs }, null, 2));
    return 0;
  }
  return await host.nx(nxArgs) || host.runSuites(plan.suites);
}

export function runTask(args: TaskArgs, host: TaskHost): Promise<number> {
  return args.kind === "typecheck" ? typecheck(args, host) : test(args, host);
}

/** Nx with no daemon, Cloud or TUI, whatever the caller's environment says. */
function nxEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, NX_DAEMON: "false", NX_NO_CLOUD: "true", NX_TUI: "false" };
}

/** The installed Nx's own entry point, from its manifest's `bin`, or null when it isn't installed. */
export function nxEntry(root: string): string | null {
  const dir = join(root, "node_modules", "nx");
  try {
    const { bin } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const entry = typeof bin === "string" ? bin : bin?.nx;
    return typeof entry === "string" && existsSync(join(dir, entry)) ? join(dir, entry) : null;
  } catch {
    return null;
  }
}

export function productionHost(root: string): TaskHost {
  return {
    root,
    checkLinks: () => checkWorkspaceLinks(root),
    nx: (args) => {
      const nxBin = nxEntry(root);
      if (!nxBin) {
        console.error(`Nx is not installed in ${join(root, "node_modules", "nx")}.\nPlease run npm install in your checkout, then retry.`);
        return Promise.resolve(1);
      }
      return runProcess(process.execPath, [nxBin, ...args], { cwd: root, label: "Nx", env: nxEnvironment() });
    },
    runSuites: (suites) => runTestSuites(suites, { cwd: root }),
    git: gitIn(root),
    log: (message) => console.error(message),
    print: (text) => console.log(text),
  };
}

async function main(): Promise<number> {
  let args: TaskArgs;
  try {
    args = taskArguments(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  return runTask(args, productionHost(fileURLToPath(new URL("..", import.meta.url))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(error); process.exitCode = 1; });
}
