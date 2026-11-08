import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { projectForPath, testProjects, type TestProject } from "./test-projects.ts";

/**
 * The Nx projects whose `typecheck` target a change can affect: the projects that
 * own a changed file, and every project that depends on one of them, directly or
 * through another. Anything this can't place falls back to every project.
 */

export type TypecheckSelection =
  | { full: false; projects: string[]; changed: string[]; consumers: string[]; ignored: string[] }
  | { full: true; reasons: string[] };

/** `tsconfig.test.json` compiles `scripts/` with `test/`, so scripts belong to the checks project. */
const SCRIPTS_OWNER = "checks";
const PROJECT_CONFIG = /(^|\/)(project|package|tsconfig[^/]*)\.json$/;

/** Root files every task hashes (`sharedGlobals` in nx.json): any change to one affects everything. */
export function sharedInputs(root: string): Set<string> {
  const nx = JSON.parse(readFileSync(join(root, "nx.json"), "utf8"));
  const globals: unknown[] = nx.namedInputs?.sharedGlobals ?? [];
  return new Set(globals.flatMap((input) => typeof input === "string" && input.startsWith("{workspaceRoot}/")
    ? [input.slice("{workspaceRoot}/".length)] : []));
}

/** Every project that depends on one of `names`, transitively, excluding `names` themselves. */
export function consumersOf(names: Iterable<string>, projects: readonly TestProject[]): Set<string> {
  const selected = new Set(names);
  const start = new Set(selected);
  for (let grew = true; grew;) {
    grew = false;
    for (const project of projects) {
      if (selected.has(project.name) || !project.dependencies.some((dependency) => selected.has(dependency))) continue;
      selected.add(project.name);
      grew = true;
    }
  }
  return new Set([...selected].filter((name) => !start.has(name)));
}

type Placement = { project: string } | { ignored: true } | { global: string };

function place(file: string, globals: Set<string>, projects: readonly TestProject[]): Placement {
  if (globals.has(file)) return { global: `Shared input for every task: ${file}` };
  const project = file.startsWith("scripts/") ? SCRIPTS_OWNER : projectForPath(file, projects);
  if (project && PROJECT_CONFIG.test(file)) return { global: `Project configuration can change the graph: ${file}` };
  if (project) return { project };
  // No tsconfig compiles Markdown, so documentation outside a project is not a typecheck input.
  if (file.endsWith(".md")) return { ignored: true };
  return { global: `No project owns ${file}` };
}

export function affectedTypecheckProjects(root: string, changed: readonly string[] | null): TypecheckSelection {
  if (changed === null) return { full: true, reasons: ["Changed files are unavailable"] };
  let projects: TestProject[];
  let globals: Set<string>;
  try {
    projects = testProjects(root);
    globals = sharedInputs(root);
  } catch (error) {
    return { full: true, reasons: [`Cannot read the project graph: ${String(error)}`] };
  }
  const touched = new Set<string>();
  const ignored: string[] = [];
  const reasons: string[] = [];
  for (const raw of changed) {
    const placement = place(posix.normalize(raw.replaceAll("\\", "/")), globals, projects);
    if ("global" in placement) reasons.push(placement.global);
    else if ("ignored" in placement) ignored.push(raw);
    else touched.add(placement.project);
  }
  if (reasons.length) return { full: true, reasons };
  if (!touched.size) return { full: true, reasons: ["No changed file is a typecheck input, and an empty selection would report success without checking anything"] };
  const consumers = consumersOf(touched, projects);
  const order = (names: Iterable<string>) => projects.map((project) => project.name).filter((name) => new Set(names).has(name));
  return {
    full: false,
    projects: order([...touched, ...consumers]),
    changed: order(touched),
    consumers: order(consumers),
    ignored,
  };
}
