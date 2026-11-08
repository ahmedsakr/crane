import { readdirSync } from "node:fs";
import { posix } from "node:path";
import { TEST_GROUPS, type TestGroup } from "./test-groups.ts";
import { importedTestProjects, projectClosure, projectForPath, testProjects, type TestProject } from "./test-projects.ts";

export interface SuiteCatalog {
  suites: string[];
  owners: Record<string, string>;
  problems: string[];
}

/** The same immediate test/*.test.ts set the existing shell glob passes to Node. */
export function rootSuites(root: string): string[] {
  return readdirSync(`${root}/test`).filter((name) => !name.startsWith(".") && name.endsWith(".test.ts"))
    .map((name) => `test/${name}`).sort();
}

export function suiteCatalog(suites: readonly string[], groups: readonly TestGroup[] = TEST_GROUPS): SuiteCatalog {
  const owners: Record<string, string> = {};
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.id)) throw new Error(`Duplicate test group: ${group.id}`);
    ids.add(group.id);
    for (const suite of group.suites) {
      if (owners[suite]) throw new Error(`Duplicate test owner for ${suite}: ${owners[suite]}, ${group.id}`);
      owners[suite] = group.id;
      if (!suites.includes(suite)) problems.push(`Deleted or missing suite: ${suite} (${group.id})`);
    }
  }
  for (const suite of suites) {
    if (!owners[suite]) {
      owners[suite] = "unclassified";
      problems.push(`Unassigned suite: ${suite}`);
    }
  }
  return { suites: [...new Set(suites)].sort(), owners, problems };
}

export function dependencyProblems(root: string, groups: readonly TestGroup[], projects: readonly TestProject[]): string[] {
  return groups.flatMap((group) => {
    if (group.repositoryWide) return [];
    const declared = projectClosure(group.projects, projects);
    return group.suites.flatMap((suite) => [...importedTestProjects(root, suite, projects)]
      .filter((project) => !declared.has(project)).map((project) => `${suite} (${group.id}) needs ${project}`));
  });
}

export interface TestPlan {
  groups: string[];
  suites: string[];
  /** A nonempty list means the requested subset was replaced by the full suite set. */
  fallback: string[];
}

export function testPlan(root: string, requested?: readonly string[], groups: readonly TestGroup[] = TEST_GROUPS): TestPlan {
  const catalog = suiteCatalog(rootSuites(root), groups);
  if (requested?.some((id) => !groups.some((group) => group.id === id))) throw new Error("Unknown test group in request");
  if (requested?.length === 0) throw new Error("Select at least one test group, or omit groups for full execution");
  if (!catalog.suites.length) throw new Error("No root test suites found");
  const selected = requested && !catalog.problems.length ? new Set(requested) : new Set(groups.map((group) => group.id));
  return {
    groups: [...selected],
    suites: catalog.suites.filter((suite) => catalog.problems.length || selected.has(catalog.owners[suite]!)),
    fallback: catalog.problems,
  };
}

/**
 * Selection interface for the wiring task. Paths must include additions, removals,
 * both rename sides, and any documented local changes. History lookup is the caller's job.
 * Missing/uncertain input (null), catalog drift or dependency drift falls back to all groups.
 */
export function affectedTestGroups(root: string, changed: readonly string[] | null, groups: readonly TestGroup[] = TEST_GROUPS): TestPlan {
  const full = testPlan(root, undefined, groups);
  if (changed === null) return { ...full, fallback: [...full.fallback, "Changed inputs unavailable"] };
  if (full.fallback.length) return full;
  try {
    const projects = testProjects(root);
    const problems = dependencyProblems(root, groups, projects);
    if (problems.length) return { ...full, fallback: problems };
    return selectChanges(changed, { full, groups, projects });
  } catch (error) {
    return { ...full, fallback: [`Cannot verify test dependencies: ${String(error)}`] };
  }
}

function selectChanges(changed: readonly string[], context: { full: TestPlan; groups: readonly TestGroup[]; projects: readonly TestProject[] }): TestPlan {
  const { full, groups, projects } = context;
  const selected = new Set<string>();
  for (const raw of changed) {
    const file = posix.normalize(raw.replaceAll("\\", "/"));
    const owner = groups.find((group) => group.suites.includes(file));
    const project = projectForPath(file, projects);
    const config = /\/(project|package|tsconfig[^/]*)\.json$/.test(file);
    // Shared helpers/scripts/configs and unrecognized paths are deliberately global.
    if ((!owner && (!project || project === "checks")) || config) {
      return { ...full, fallback: [`Global or unclassified input: ${raw}`] };
    }
    if (project && project !== "checks" && !groups.some((group) => projectClosure(group.projects, projects).has(project))) {
      return { ...full, fallback: [`Project has no test dependency owner: ${project}`] };
    }
    for (const group of groups) {
      if (group.repositoryWide || group.id === owner?.id || (project && projectClosure(group.projects, projects).has(project))) selected.add(group.id);
    }
  }
  return { groups: [...selected], suites: full.suites.filter((suite) => groups.some((group) => selected.has(group.id) && group.suites.includes(suite))), fallback: [] };
}
