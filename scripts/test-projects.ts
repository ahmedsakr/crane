import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { moduleRefs, type ModuleRef } from "../test/support/imports.ts";

export interface TestProject {
  name: string;
  root: string;
  dependencies: string[];
}

function packageRoots(root: string): string[] {
  return readdirSync(join(root, "packages"))
    .map((dir) => `packages/${dir}`)
    .filter((dir) => existsSync(join(root, dir, "project.json")) || existsSync(join(root, dir, "package.json")));
}

function manifest(root: string, dir: string) {
  return JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
}

/** The full build still has its own package inventory if the selection graph is unreadable. */
export function packageBuildProjects(root: string): string[] {
  return packageRoots(root).map((dir) => manifest(root, dir).name);
}

/** Read the foundation's explicit graph; never make the root npm package a project. */
export function testProjects(root: string): TestProject[] {
  const packages = packageRoots(root);
  const projects: TestProject[] = [...packages, "src", "web", "test"].map((dir) => {
    const project = JSON.parse(readFileSync(join(root, dir, "project.json"), "utf8"));
    const dependencies = project.implicitDependencies;
    if (typeof project.name !== "string" || !project.name || !Array.isArray(dependencies) ||
        dependencies.some((name) => typeof name !== "string")) {
      throw new Error(`Invalid test project: ${dir}`);
    }
    return { name: project.name, root: dir, dependencies };
  });
  validateGraph(root, projects, [...packages, "web"]);
  return projects;
}

function validateGraph(root: string, projects: readonly TestProject[], workspaces: readonly string[]): void {
  const names = new Set(projects.map(({ name }) => name));
  if (names.size !== projects.length) throw new Error("Duplicate test project name");
  projectClosure([...names], projects);
  for (const dir of workspaces) {
    const pkg = manifest(root, dir);
    const project = projects.find((entry) => entry.root === dir)!;
    const deps = Object.keys(pkg.dependencies ?? {}).filter((name) => names.has(name)).sort();
    if (pkg.name !== project.name || deps.join() !== [...project.dependencies].sort().join()) {
      throw new Error(`Test project graph differs from manifest: ${dir}`);
    }
  }
}

export function projectClosure(names: readonly string[], projects: readonly TestProject[]): Set<string> {
  const found = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (found.has(name)) return;
    if (visiting.has(name)) throw new Error(`Cycle in test project dependencies: ${name}`);
    const project = projects.find((entry) => entry.name === name);
    if (!project) throw new Error(`Unknown test dependency project: ${name}`);
    visiting.add(name);
    for (const dependency of project.dependencies) visit(dependency);
    visiting.delete(name);
    found.add(name);
  };
  for (const name of names) visit(name);
  return found;
}

export function projectForPath(file: string, projects: readonly TestProject[]): string | undefined {
  return projects.find((project) => file.startsWith(`${project.root}/`))?.name;
}

function sourceFile(file: string): string {
  const candidates = [file.replace(/\.js$/, ".ts"), file.replace(/\.jsx?$/, ".tsx"), file,
    `${file}.ts`, `${file}.tsx`, join(file, "index.ts"), join(file, "index.tsx")];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Unresolved test dependency: ${file}`);
  return found;
}

export interface SuiteDependencies {
  projects: Set<string>;
  files: Set<string>;
  filesystem: Set<string>;
}

function packageSource(projectRoot: string, target: string): string {
  // Private dist imports deliberately share compiled class identity in certain suites.
  // Resolve their owning sources even when --list runs before the first build.
  return sourceFile(target.replace(`${projectRoot}${sep}dist${sep}`, `${projectRoot}${sep}src${sep}`));
}

function exportedSource(root: string, project: TestProject, spec: string): string {
  const dir = join(root, project.root);
  const subpath = spec.slice(project.name.length);
  const target = manifest(root, project.root).exports?.[`.${subpath}`]?.default;
  if (typeof target !== "string" || !target.startsWith("./dist/")) {
    throw new Error(`Unresolved test dependency: ${spec}`);
  }
  return packageSource(dir, resolve(dir, target));
}

/** Audit import sites and helper chains, stopping at project boundaries covered by the graph. */
export function testDependencyAudit(root: string, projects: readonly TestProject[]) {
  const refs = new Map<string, ModuleRef[]>();
  const workspaceImports = new Set<string>();
  const application = "src/application.ts";
  const resolveLocal = (file: string, spec: string) => {
    const target = resolve(dirname(file), spec);
    const path = relative(root, target).split(sep).join("/");
    const pkg = projects.find((entry) => entry.root.startsWith("packages/") && path.startsWith(`${entry.root}/`));
    return pkg ? packageSource(join(root, pkg.root), target) : sourceFile(target);
  };

  return (suite: string): SuiteDependencies => {
    const deps: SuiteDependencies = { projects: new Set(), files: new Set(), filesystem: new Set() };
    const visited = new Set<string>();
    const followLocal = (file: string, spec: string) => {
      const target = resolveLocal(file, spec);
      const path = relative(root, target).split(sep).join("/");
      const project = projectForPath(path, projects);
      if (project && project !== "checks" && path !== application) {
        deps.projects.add(project);
      } else {
        if (isAbsolute(path) || path.startsWith("../")) throw new Error(`Test dependency outside checkout: ${path}`);
        deps.files.add(path);
        visit(target);
      }
    };
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const imports = refs.get(file) ?? moduleRefs(file, { literalUrls: true });
      refs.set(file, imports);
      for (const { spec, typeOnly } of imports) {
        if (spec === null) {
          for (const project of projects) if (project.name !== "checks") deps.projects.add(project.name);
        } else if (spec.startsWith(".")) {
          followLocal(file, spec);
        } else {
          if (!typeOnly && /^(node:)?fs(?:\/promises)?$/.test(spec)) deps.filesystem.add(relative(root, file).split(sep).join("/"));
          const workspace = projects.find(({ name }) => spec === name || spec.startsWith(`${name}/`));
          if (workspace) {
            if (!workspaceImports.has(spec)) exportedSource(root, workspace, spec);
            workspaceImports.add(spec);
            deps.projects.add(workspace.name);
          } else if (!isBuiltin(spec)) {
            createRequire(file).resolve(spec);
          }
        }
      }
    };
    visit(join(root, suite));
    return deps;
  };
}

export function importedTestProjects(root: string, suite: string, projects: readonly TestProject[]): Set<string> {
  return testDependencyAudit(root, projects)(suite).projects;
}
