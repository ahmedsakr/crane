import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { TEST_GROUPS } from "./test-groups.ts";
import { rootSuites, suiteCatalog } from "./test-ownership.ts";
import { checkProjects, projectClosure, testDependencyAudit, testProjects } from "./test-projects.ts";

/** Compilation can share a process between execution groups with similar dependencies. */
const SUITE_PARTITIONS = {
  agents: [
    "package-contracts", "package-agent-protocol", "package-agent-policy",
    "package-agent-drivers", "package-diagnostics", "package-worktree-deps",
  ],
  storage: ["backend-runtime", "storage", "storage-agent-evidence", "storage-check-reports"],
  factory: ["factory-actions", "factory-agents", "factory-execution"],
  http: ["http", "http-factory"],
  cli: ["cli", "cli-http"],
  web: ["web", "web-policy"],
  "web-http": ["web-http"],
  tooling: ["architecture", "build"],
};

const SUPPORT = "support";
const CLI_HELPER = "test/support/auth-e2e.ts";
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const CHECKS_DECLARATION = /^(scripts|test)\/.*\.d\.[cm]?ts$/;
const DECLARATIONS = ["scripts", "test"].flatMap((dir) =>
  ["ts", "mts", "cts"].map((ext) => `${dir}/**/*.d.${ext}`));

export const partitionRoot = (id: string) => `test/typecheck/${id}`;
export const partitionName = (id: string) => `checks-${id}`;
const inputs = (paths: readonly string[]) => paths.map((path) => `{workspaceRoot}/${path}`);

export function partitionSuites(): Map<string, string[]> {
  const owners = new Map<string, string>();
  for (const [id, groups] of Object.entries(SUITE_PARTITIONS)) {
    for (const group of groups) {
      if (owners.has(group)) throw new Error(`Duplicate typecheck owner for test group ${group}`);
      owners.set(group, id);
    }
  }
  const partitions = new Map(Object.keys(SUITE_PARTITIONS).map((id) => [id, [] as string[]]));
  for (const group of TEST_GROUPS) {
    const id = owners.get(group.id);
    if (!id) throw new Error(`No typecheck partition for test group ${group.id}`);
    owners.delete(group.id);
    partitions.get(id)!.push(...group.suites);
  }
  if (owners.size) throw new Error(`Unknown test groups: ${[...owners.keys()].join(", ")}`);
  partitions.get("cli")!.push(CLI_HELPER);
  return partitions;
}

function sourceFiles(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (["node_modules", "dist"].includes(entry.name)) return [];
      return sourceFiles(root, path);
    }
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

export function supportOwns(file: string): boolean {
  return SOURCE.test(file) && /^(scripts|test)\//.test(file) &&
    !/^test\/[^/]+\.test\.ts$/.test(file) && file !== CLI_HELPER;
}

interface Partition {
  id: string;
  entries: string[];
  dependencies: string[];
  imports: string[];
  builds: string[];
}

function partitions(root: string): Partition[] {
  const catalog = suiteCatalog(rootSuites(root));
  if (catalog.problems.length) throw new Error(catalog.problems.join("\n"));
  const projects = testProjects(root);
  const audit = testDependencyAudit(root, projects, "compilation");
  const entriesById = partitionSuites();
  const support = ["scripts", "test"].flatMap((dir) => sourceFiles(root, dir)).filter(supportOwns);
  const declarations = support.filter((file) => CHECKS_DECLARATION.test(file));
  entriesById.set(SUPPORT, support);
  return [...entriesById].map(([id, entries]) => {
    const dependencies = new Set<string>();
    const imports = new Set<string>();
    const roots = new Set([...entries, ...declarations]);
    for (const entry of roots) {
      const actual = audit(entry);
      for (const project of actual.projects) dependencies.add(project);
      for (const file of actual.files) {
        if (roots.has(file)) continue;
        if (catalog.owners[file] || file === CLI_HELPER) throw new Error(`${entry} imports another partition's entry: ${file}`);
        imports.add(file);
      }
    }
    const builds = [...projectClosure([...dependencies], projects)].filter((name) => name.startsWith("@crane/") && name !== "@crane/web");
    return { id, entries: entries.sort(), dependencies: [...dependencies].sort(), imports: [...imports].sort(), builds: builds.sort() };
  });
}

function projectConfig(partition: Partition) {
  const { id, entries, dependencies, imports, builds } = partition;
  const dir = partitionRoot(id);
  const ownedInputs = id === SUPPORT
    ? [...inputs(["scripts/**/*", "test/**/*"]), "!{workspaceRoot}/test/*.test.ts", `!{workspaceRoot}/${CLI_HELPER}`]
    : inputs(entries);
  return {
    $schema: "../../../node_modules/nx/schemas/project-schema.json",
    name: partitionName(id),
    projectType: "application",
    tags: ["kind:checks"],
    implicitDependencies: dependencies,
    targets: {
      typecheck: {
        executor: "nx:run-commands",
        options: {
          command: `node scripts/check-workspace-links.mjs && tsc -p ${dir}/tsconfig.json`,
          cwd: "{workspaceRoot}",
        },
        dependsOn: builds.length ? [{ projects: builds, target: "build" }] : [],
        inputs: ["default", "^default", "checksDeclarations", ...ownedInputs, ...inputs(imports)],
        outputs: [],
        cache: true,
      },
    },
  };
}

function compilerConfig({ id, entries }: Partition) {
  const local = (file: string) => posix.relative(partitionRoot(id), file);
  const base = { extends: "../../../tsconfig.checks.json" };
  if (id !== SUPPORT) return { ...base, files: entries.map(local) };
  return {
    ...base,
    // Imported declarations inform every partition. Check their bodies once here.
    compilerOptions: { skipLibCheck: false },
    include: ["scripts/**/*", "test/**/*"].map(local),
    exclude: ["test/*.test.ts", CLI_HELPER, "**/node_modules", "**/dist"].map(local),
  };
}

/** Both Nx and tsc read checked-in JSON, so neither needs a plugin or a recursive task. */
export function partitionConfigs(root: string): Map<string, unknown> {
  const configs = new Map<string, unknown>();
  const references = [];
  for (const partition of partitions(root)) {
    const dir = partitionRoot(partition.id);
    configs.set(`${dir}/project.json`, projectConfig(partition));
    configs.set(`${dir}/tsconfig.json`, compilerConfig(partition));
    references.push({ path: `./${dir}` });
  }
  configs.set("tsconfig.test.json", { files: [], references });
  return configs;
}

export function checkPartitionConfigs(root: string): void {
  const configs = partitionConfigs(root);
  for (const [file, expected] of configs) {
    let actual: unknown;
    try { actual = JSON.parse(readFileSync(join(root, file), "utf8")); } catch { /* Report missing and invalid configs together. */ }
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`Stale checks partition config: ${file}. Run node --import tsx scripts/check-partitions.ts --write`);
    }
  }
  for (const project of checkProjects(root)) {
    if (!configs.has(`${project.root}/project.json`)) throw new Error(`Remove obsolete checks project: ${project.root}`);
  }
  const nx = JSON.parse(readFileSync(join(root, "nx.json"), "utf8"));
  if (!isDeepStrictEqual(nx.namedInputs.checksDeclarations, inputs(DECLARATIONS))) {
    throw new Error("Nx checksDeclarations must hash the same declaration patterns as tsconfig.checks.json");
  }
  const base = JSON.parse(readFileSync(join(root, "tsconfig.checks.json"), "utf8"));
  if (!isDeepStrictEqual(base.include, DECLARATIONS)) throw new Error("Invalid checks declaration includes in tsconfig.checks.json");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (process.argv[2] === "--write") {
    for (const [file, config] of partitionConfigs(root)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), JSON.stringify(config, null, 2) + "\n");
    }
  } else {
    checkPartitionConfigs(root);
  }
}
