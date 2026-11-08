import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { moduleRefs } from "../test/support/imports.ts";

export interface TestProject {
  name: string;
  root: string;
  dependencies: string[];
}

/** Read the foundation's explicit graph; never make the root npm package a project. */
export function testProjects(root: string): TestProject[] {
  const packages = readdirSync(join(root, "packages"))
    .map((dir) => `packages/${dir}`).filter((dir) => existsSync(join(root, dir, "project.json")));
  return [...packages, "src", "web", "test"].map((dir) => {
    const project = JSON.parse(readFileSync(join(root, dir, "project.json"), "utf8"));
    return { name: project.name, root: dir, dependencies: project.implicitDependencies ?? [] };
  });
}

export function projectClosure(names: readonly string[], projects: readonly TestProject[]): Set<string> {
  const found = new Set<string>();
  const visit = (name: string) => {
    if (found.has(name)) return;
    const project = projects.find((entry) => entry.name === name);
    if (!project) throw new Error(`Unknown test dependency project: ${name}`);
    found.add(name);
    for (const dependency of project.dependencies) visit(dependency);
  };
  for (const name of names) visit(name);
  return found;
}

export function projectForPath(file: string, projects: readonly TestProject[]): string | undefined {
  return projects.find((project) => file.startsWith(`${project.root}/`))?.name;
}

function sourceFile(file: string): string {
  const candidates = [file.replace(/\.js$/, ".ts"), file, `${file}.ts`, `${file}.tsx`, join(file, "index.ts")];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Unresolved test dependency: ${file}`);
  return found;
}

/**
 * Audit named imports, including helper chains and private package sources.
 * This supplements explicit scan ownership; it cannot discover filesystem reads.
 */
export function importedTestProjects(root: string, suite: string, projects: readonly TestProject[]): Set<string> {
  const found = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const ref of moduleRefs(file)) {
      if (ref.spec === null) {
        // A computed import may reach any project; require conservative declared coverage.
        for (const project of projects) if (project.name !== "checks") found.add(project.name);
        continue;
      }
      if (ref.spec.startsWith(".")) {
        const target = sourceFile(resolve(dirname(file), ref.spec));
        const path = relative(root, target).split("\\").join("/");
        const project = projectForPath(path, projects);
        if (project && project !== "checks") found.add(project);
        else visit(target);
      } else {
        const project = projects.find((entry) => ref.spec === entry.name || ref.spec!.startsWith(`${entry.name}/`));
        if (project) found.add(project.name);
      }
    }
  };
  visit(join(root, suite));
  return found;
}
