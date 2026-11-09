import type { Node } from "@babel/types";
import { parseSource } from "./imports.ts";

/**
 * Responsibility checks over one source file's text, so tests can run them on
 * the tree and on inline samples alike. They read syntax, not data flow: an
 * alias like `const s = store` hides its calls, so they guard the conventions
 * the code follows rather than prove what it can't do.
 */

/** A relative specifier in `file`, resolved to a path under the same root like `factory/git`. */
export function resolveSpec(file: string, spec: string): string {
  const parts = file.split("/").slice(0, -1);
  for (const seg of spec.replace(/\.(js|tsx?)$/, "").split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

interface Import {
  spec: string;
  line: number;
  /** Imported names, `*` for a namespace, or `default`. Empty for `import()` and side-effect imports. */
  names: string[];
  typeOnly: boolean;
  lazy: boolean;
}

function walk(node: Node, visit: (node: Node, parent: Node | null) => void, parent: Node | null = null): void {
  visit(node, parent);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (typeof child?.type === "string") walk(child, visit, node);
    }
  }
}

function importedName(specifier: Node): string {
  if (specifier.type === "ImportNamespaceSpecifier") return "*";
  if (specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier") return specifier.imported.name;
  return "default";
}

function importsIn(path: string, source: string): Import[] {
  const found: Import[] = [];
  walk(parseSource(source, path).program, (node) => {
    const line = node.loc?.start.line ?? 1;
    if (node.type === "ImportDeclaration") {
      const typeOnly = node.importKind === "type" || (node.specifiers.length > 0
        && node.specifiers.every((s) => s.type === "ImportSpecifier" && s.importKind === "type"));
      found.push({ spec: node.source.value, line, names: node.specifiers.map(importedName), typeOnly, lazy: false });
    } else if (node.type === "ImportExpression" && node.source.type === "StringLiteral") {
      found.push({ spec: node.source.value, line, names: [], typeOnly: false, lazy: true });
    }
  });
  return found;
}

/** The property a member expression reads, when it is spelled out. */
function propertyName(node: Node): string | null {
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return null;
  return node.property.type === "Identifier" && !node.computed ? node.property.name : null;
}

/** `store`, `ctx.store`, `this.store`, `deps.store` and the like. */
function isStore(node: Node): boolean {
  if (node.type === "Identifier") return node.name === "store";
  return propertyName(node) === "store";
}

/** Every `<store>.name` member access, with its line. */
function storeMembers(path: string, source: string): { name: string; line: number }[] {
  const found: { name: string; line: number }[] = [];
  walk(parseSource(source, path).program, (node) => {
    const name = propertyName(node);
    if (name && (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && isStore(node.object)) {
      found.push({ name, line: node.loc?.start.line ?? 1 });
    }
  });
  return found;
}

/** Module ids each file imports at runtime (type-only imports are erased), resolved under the same root. */
export function runtimeImports(path: string, source: string): string[] {
  return importsIn(path, source)
    .filter((ref) => ref.spec.startsWith(".") && !ref.typeOnly)
    .map((ref) => resolveSpec(path, ref.spec));
}

/** The first import cycle in `graph` (module id to the ids it imports), as a closed path, or null. */
export function findCycle(graph: Map<string, string[]>): string[] | null {
  const done = new Set<string>();
  const search = (mod: string, path: string[]): string[] | null => {
    if (path.includes(mod)) return [...path.slice(path.indexOf(mod)), mod];
    if (done.has(mod)) return null;
    for (const next of graph.get(mod) ?? []) {
      const cycle = search(next, [...path, mod]);
      if (cycle) return cycle;
    }
    done.add(mod);
    return null;
  };
  for (const mod of graph.keys()) {
    const cycle = search(mod, []);
    if (cycle) return cycle;
  }
  return null;
}

/** Where code outside the store reaches its database: `store.db` or better-sqlite3. */
export function databaseViolations(path: string, source: string): string[] {
  const imports = importsIn(path, source)
    .filter((ref) => ref.spec === "better-sqlite3")
    .map((ref) => `${path}:${ref.line} imports better-sqlite3`);
  const handles = storeMembers(path, source)
    .filter((member) => member.name === "db")
    .map((member) => `${path}:${member.line} uses store.db`);
  return [...imports, ...handles];
}

/** `pages/Home` for a top-level page, `pages/task` for a part of one, null outside pages/. */
function pageUnit(module: string): { kind: "page" | "part"; name: string } | null {
  const match = /^pages\/([^/]+)(\/.+)?$/.exec(module);
  if (!match) return null;
  return match[2] ? { kind: "part", name: match[1]! } : { kind: "page", name: match[1]! };
}

/** Which `pages/<dir>/` holds each page's parts. Pages not listed have none; Goals and GoalPage share theirs. */
export const PAGE_PARTS: Record<string, string> = {
  Analytics: "analytics",
  Crew: "crew",
  Goals: "goals",
  GoalPage: "goals",
  Operators: "operators",
  Join: "join",
  Repos: "repos",
  TaskPage: "task",
};

/** The parts directory `module` (a path under web/src without extension) may import from, if any. */
function ownParts(module: string): string | null {
  const unit = pageUnit(module);
  if (unit?.kind === "part") return unit.name;
  return unit ? PAGE_PARTS[unit.name] ?? null : null;
}

/**
 * Pages are leaves App routes to: nothing but App imports a page. A page's parts
 * under `pages/<dir>/` are imported only by that page and by each other, so one
 * page never reaches into another's pieces. Shared pieces belong in components/ or lib/.
 */
export function pageImportViolations(path: string, source: string): string[] {
  const from = path.replace(/\.tsx?$/, "");
  return importsIn(path, source).flatMap((ref) => {
    if (!ref.spec.startsWith(".")) return [];
    const target = resolveSpec(path, ref.spec);
    const unit = pageUnit(target);
    if (unit?.kind === "page" && from !== "App") return [`${path}:${ref.line} imports the page ${target}`];
    if (unit?.kind === "part" && ownParts(from) !== unit.name) {
      return [`${path}:${ref.line} imports ${target}, a part of another page`];
    }
    return [];
  });
}

/** Store methods that only read. Commands and routes may call these and nothing else on the store. */
export const STORE_READS = new Set([
  "getGoal", "listGoals", "listGoalSummaries", "goalListItems", "goalDetail", "goalForTask", "listCrewSchedules",
  "getSetting", "publicUrl", "retentionSettings", "postmortemSettings", "postmortemCrew", "isPaused", "listRepos", "getRepo",
  "repoTools", "repoChecks", "blockedTools", "getTask", "listTasks", "listTaskSummaries", "tasksWithWorktrees",
  "listQueuedTasks", "listQueuedTaskSummaries", "queuedForAnyone", "prerequisiteStates", "prerequisiteCommits",
  "unmetPrerequisites", "followUps", "followUpSource", "listEvents", "commandEvidence", "eventsSince", "latestEventId",
  "listRuns", "lastWorkDriver", "hasRunningRun", "analytics", "listAgents", "crewActive", "crewDefaultDriver", "crewRole",
  "overview",
]);

/** Store calls that change state outside `OperatorActions`, and why each is legitimate. */
export const STORE_EXCEPTIONS: Record<string, string> = {
  syncGoals: "reconciles each goal's status with its tasks' before a goal read, as the factory loop does; it is idempotent and takes no operator input",
  close: "closes the command's own database handle, so `crane start` can hand the database to the process it supervises",
};

/** Modules commands and routes may import, by path under src/, and which names (`*` for any). */
const ALLOWED_MODULES: Record<string, string[]> = {
  "core/store": ["Store"],
  "core/screenshots": ["readScreenshot", "screenshotPath"],
  // AccessError only so the invite routes can tell a bad link (401) from bad input when counting guesses.
  "factory/actions": ["AccessError", "OperatorActions", "WRONG_CURRENT_PASSWORD", "checkLookouts", "checkScheduledAt", "toRule"],
  "factory/git": ["diffForTask"],
  "factory/instruct": ["draftTask"],
  "factory/settings": ["*"],
  "factory/state": ["factoryState", "factoryIsRunning", "factoryDriverName"],
  "cli/ui": ["*"],
  "cli/context": ["*"],
  // Startup certificate validation only reads files and creates a TLS context; it never changes factory state.
  "cli/tls": ["loadTls", "TlsOptions"],
  "server/body": ["*"],
  "server/security": ["*"],
  // The session cookie, the gate's per-request check, and who a signed-in request acts as. Sessions change only
  // through OperatorActions.
  "server/auth": ["admit", "clearSessionCookie", "sessionToken", "setSessionCookie", "signedInActor"],
  // The in-memory sign-in limiter, which counts failed attempts and never touches the store.
  "server/sign-in-limit": ["TooManyAttempts"],
};

const ALLOWED_PACKAGES: Record<string, string[]> = {
  "@crane/backend-runtime": ["DEFAULT_HOST", "DEFAULT_PORT"],
  "@crane/contracts": ["*"],
  "@clack/prompts": ["*"],
  commander: ["*"],
  hono: ["*"],
  "hono/streaming": ["*"],
  picocolors: ["*"],
  "node:path": ["*"],
  "node:fs": ["readFileSync", "existsSync"],
};

/**
 * `crane serve` and `crane start` run the factory itself, the process that does
 * the work operator actions queue, so their command loads it only when it runs.
 */
export const LAZY_RUNTIME_EXCEPTIONS: Record<string, string[]> = {
  "cli/commands/serve.ts": ["cli/serve", "cli/start"],
};

function importViolation(path: string, ref: Import): string | null {
  const local = ref.spec.startsWith(".");
  const target = local ? resolveSpec(path, ref.spec) : ref.spec;
  if (local && target.split("/").slice(0, -1).join("/") === path.split("/").slice(0, -1).join("/")) return null;
  if (ref.lazy) {
    return LAZY_RUNTIME_EXCEPTIONS[path]?.includes(target) ? null : `${path}:${ref.line} loads ${target}`;
  }
  const allowed = (local ? ALLOWED_MODULES : ALLOWED_PACKAGES)[target];
  if (!allowed) return `${path}:${ref.line} imports ${target}`;
  if (ref.typeOnly || allowed.includes("*")) return null;
  const extra = ref.names.filter((name) => !allowed.includes(name));
  return extra.length ? `${path}:${ref.line} imports ${extra.join(", ")} from ${target}` : null;
}

/**
 * How a CLI command or API route module changes state other than through
 * `OperatorActions`: a store call that isn't a read or a listed exception, the
 * raw database, or an import that could write (git, files, drivers, the factory).
 */
export function stateChangeViolations(path: string, source: string): string[] {
  const calls = storeMembers(path, source)
    .filter((member) => !STORE_READS.has(member.name) && !(member.name in STORE_EXCEPTIONS))
    .map((member) => `${path}:${member.line} calls store.${member.name}; change state through OperatorActions`);
  const imports = importsIn(path, source).flatMap((ref) => importViolation(path, ref) ?? []);
  return [...calls, ...imports];
}
