import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Node } from "@babel/types";
import { parseSource } from "./imports.ts";

export const RULES = ["nestedTernary", "functionLines", "parameters", "depth", "fileLines"] as const;
export type ShapeRule = (typeof RULES)[number];
export type ShapeCounts = Partial<Record<ShapeRule, number>>;

/** The most each rule allows: a value above its limit is a violation. */
export const LIMITS: Record<ShapeRule, number> = {
  nestedTernary: 1,
  functionLines: 60,
  parameters: 5,
  depth: 4,
  fileLines: 500,
};

const MEASURES: Record<ShapeRule, string> = {
  nestedTernary: "ternary nesting level",
  functionLines: "lines of code",
  parameters: "parameters",
  depth: "block depth",
  fileLines: "physical lines",
};

export const BASELINE_DIR = "test/support/code-shape-baseline";

const SCANNED_EXTENSIONS = /\.(ts|tsx|mjs)$/;
const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);
const BLOCK_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "TryStatement",
]);

export interface Violation {
  rule: ShapeRule;
  line: number;
  /** The enclosing function, `<module>` for top-level code, or `<file>` for the file rule. */
  name: string;
  measured: number;
}

export interface FunctionShape {
  name: string;
  line: number;
  codeLines: number;
}

export interface FileShape {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  violations: Violation[];
  /** Every function measured against the function rules; empty for test suites. */
  functions: FunctionShape[];
}

type FunctionNode = Extract<Node, {
  type: "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression" | "ObjectMethod" | "ClassMethod" | "ClassPrivateMethod";
}>;

interface Scope {
  name: string;
  className: string | null;
  ternaries: number;
  blocks: number;
}

interface Span {
  start: number;
  end: number;
}

interface Facts {
  violations: Violation[];
  functions: { name: string; startLine: number; endLine: number }[];
  commentSpans: Span[];
}

function isFunction(node: Node): node is FunctionNode {
  return node.type === "FunctionDeclaration"
    || node.type === "FunctionExpression"
    || node.type === "ArrowFunctionExpression"
    || node.type === "ObjectMethod"
    || node.type === "ClassMethod"
    || node.type === "ClassPrivateMethod";
}

function keyText(node: Node | null | undefined): string | null {
  switch (node?.type) {
    case "Identifier":
    case "JSXIdentifier":
      return node.name;
    case "StringLiteral":
      return node.value;
    case "PrivateName":
      return `#${node.id.name}`;
    case "MemberExpression":
    case "OptionalMemberExpression":
      return keyText(node.property);
    default:
      return null;
  }
}

function qualified(key: Node, className: string | null): string {
  const name = keyText(key) ?? "<computed>";
  return className ? `${className}.${name}` : name;
}

/** Names an anonymous function after whatever it is assigned or passed to. */
function nameFromParent(parent: Node | null, className: string | null): string | null {
  switch (parent?.type) {
    case "VariableDeclarator":
      return keyText(parent.id);
    case "AssignmentExpression":
      return keyText(parent.left);
    case "ObjectProperty":
      return keyText(parent.key);
    case "ClassProperty":
    case "ClassPrivateProperty":
      return qualified(parent.key, className);
    case "JSXAttribute":
      return keyText(parent.name);
    case "ExportDefaultDeclaration":
      return "default";
    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression": {
      const callee = keyText(parent.callee);
      return callee && `${callee} callback`;
    }
    default:
      return null;
  }
}

function functionName(node: FunctionNode, parent: Node | null, className: string | null): string {
  if (node.type === "ClassMethod" || node.type === "ClassPrivateMethod") return qualified(node.key, className);
  if (node.type === "ObjectMethod") return qualified(node.key, null);
  if (node.type !== "ArrowFunctionExpression" && node.id) return node.id.name;
  return nameFromParent(parent, className) ?? "<anonymous>";
}

function parameterCount(node: FunctionNode): number {
  // A TypeScript `this` parameter only types the receiver: no caller passes it.
  return node.params.filter((param) => !(param.type === "Identifier" && param.name === "this")).length;
}

function enterFunction(node: FunctionNode, parent: Node | null, scope: Scope, facts: Facts): Scope {
  const name = functionName(node, parent, scope.className);
  const startLine = node.loc?.start.line ?? 1;
  facts.functions.push({ name, startLine, endLine: node.loc?.end.line ?? startLine });
  const parameters = parameterCount(node);
  if (parameters > LIMITS.parameters) {
    facts.violations.push({ rule: "parameters", line: startLine, name, measured: parameters });
  }
  return { name, className: scope.className, ternaries: 0, blocks: 0 };
}

function enterTernary(node: Node, scope: Scope, facts: Facts): Scope {
  const ternaries = scope.ternaries + 1;
  if (ternaries > LIMITS.nestedTernary) {
    facts.violations.push({ rule: "nestedTernary", line: node.loc?.start.line ?? 1, name: scope.name, measured: ternaries });
  }
  return { ...scope, ternaries };
}

function enterBlock(node: Node, parent: Node | null, scope: Scope, facts: Facts): Scope {
  // `else if` reads as the next branch of its chain, not one level deeper.
  const elseIf = node.type === "IfStatement" && parent?.type === "IfStatement" && parent.alternate === node;
  if (elseIf) return scope;
  const blocks = scope.blocks + 1;
  if (blocks > LIMITS.depth) {
    facts.violations.push({ rule: "depth", line: node.loc?.start.line ?? 1, name: scope.name, measured: blocks });
  }
  return { ...scope, blocks };
}

function enter(node: Node, parent: Node | null, scope: Scope, facts: Facts): Scope {
  if (isFunction(node)) return enterFunction(node, parent, scope, facts);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    return { ...scope, className: node.id?.name ?? null };
  }
  if (node.type === "ConditionalExpression") return enterTernary(node, scope, facts);
  if (BLOCK_TYPES.has(node.type)) return enterBlock(node, parent, scope, facts);
  return scope;
}

function visit(node: Node, parent: Node | null, scope: Scope, facts: Facts): void {
  // `{/* note */}` is a comment in JSX, but Babel only marks the inner part as one.
  if (node.type === "JSXExpressionContainer" && node.expression.type === "JSXEmptyExpression") {
    facts.commentSpans.push({ start: node.start ?? 0, end: node.end ?? 0 });
  }
  const inner = enter(node, parent, scope, facts);
  // The braces in `onClick={() => ...}` add nothing, so a handler is named after its attribute.
  const childParent = node.type === "JSXExpressionContainer" ? parent : node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (typeof child?.type === "string") visit(child, childParent, inner, facts);
    }
  }
}

function blankSpans(source: string, spans: Span[]): string {
  let text = "";
  let at = 0;
  for (const { start, end } of [...spans].sort((a, b) => a.start - b.start)) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    text += source.slice(at, from) + source.slice(from, end).replace(/[^\n]/g, " ");
    at = end;
  }
  return text + source.slice(at);
}

/** For each line number, how many lines up to and including it hold code. */
function runningCodeLines(source: string, commentSpans: Span[]): number[] {
  const totals = [0];
  let total = 0;
  for (const line of blankSpans(source, commentSpans).split("\n")) {
    if (line.trim()) total += 1;
    totals.push(total);
  }
  return totals;
}

function physicalLines(source: string): number {
  const lines = source.split("\n").length;
  return source.endsWith("\n") ? lines - 1 : lines;
}

function collectFacts(path: string, source: string): Facts {
  const facts: Facts = { violations: [], functions: [], commentSpans: [] };
  let ast;
  try {
    ast = parseSource(source, path);
  } catch (error) {
    throw new Error(`Code shape could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const comment of ast.comments ?? []) {
    facts.commentSpans.push({ start: comment.start ?? 0, end: comment.end ?? 0 });
  }
  visit(ast.program, null, { name: "<module>", className: null, ternaries: 0, blocks: 0 }, facts);
  return facts;
}

/** `test/*.test.ts` follows only the ternary rule: long tables of cases are fine in a suite. */
function isTestSuite(path: string): boolean {
  return /^test\/[^/]+\.test\.ts$/.test(path);
}

/** Measures one source file's text; `path` decides which rules apply and how it is parsed. */
export function inspectSource(path: string, source: string): FileShape {
  const facts = collectFacts(path, source);
  const totals = runningCodeLines(source, facts.commentSpans);
  const functions = facts.functions.map(({ name, startLine, endLine }) => ({
    name,
    line: startLine,
    codeLines: (totals[endLine] ?? 0) - (totals[startLine - 1] ?? 0),
  }));
  const violations = [...facts.violations];
  for (const { name, line, codeLines } of functions) {
    if (codeLines > LIMITS.functionLines) violations.push({ rule: "functionLines", line, name, measured: codeLines });
  }
  const lines = physicalLines(source);
  if (lines > LIMITS.fileLines) violations.push({ rule: "fileLines", line: 1, name: "<file>", measured: lines });
  if (isTestSuite(path)) {
    return { path, violations: violations.filter((v) => v.rule === "nestedTernary"), functions: [] };
  }
  return { path, violations: violations.sort((a, b) => a.line - b.line), functions };
}

function sourceFilesUnder(root: string, directory: string): string[] {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFilesUnder(root, path);
    return entry.isFile() && SCANNED_EXTENSIONS.test(entry.name) ? [path] : [];
  });
}

/** Every source file the rules cover, sorted, relative to `root`. */
export function sourcePaths(root: string): string[] {
  const packages = existsSync(join(root, "packages"))
    ? readdirSync(join(root, "packages")).map((name) => `packages/${name}/src`)
    : [];
  return ["src", "web/src", "scripts", "test", ...packages]
    .flatMap((directory) => sourceFilesUnder(root, directory))
    .sort();
}

export function scanTree(root: string): FileShape[] {
  return sourcePaths(root).map((path) => inspectSource(path, readFileSync(join(root, path), "utf8")));
}

/** The budget file for a source path: `/` becomes `__`, so each source has its own file. */
export function budgetName(path: string): string {
  return `${path.replaceAll("/", "__")}.json`;
}

export function countViolations(violations: Violation[]): ShapeCounts {
  const counts: ShapeCounts = {};
  for (const rule of RULES) {
    const count = violations.filter((violation) => violation.rule === rule).length;
    if (count > 0) counts[rule] = count;
  }
  return counts;
}

/** Each budget file's raw text, by file name. No directory means no allowances at all. */
export function readBudgets(directory: string): Map<string, string> {
  if (!existsSync(directory)) return new Map();
  return new Map(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")]));
}

function parseBudget(raw: string): ShapeCounts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const valid = Object.entries(parsed).every(([rule, count]) => (
    (RULES as readonly string[]).includes(rule) && Number.isInteger(count) && count >= 0
  ));
  return valid ? (parsed as ShapeCounts) : null;
}

function violationLines(file: FileShape, rule?: ShapeRule): string {
  return file.violations
    .filter((violation) => !rule || violation.rule === rule)
    .map(({ rule: ruleName, line, name, measured }) => (
      `  ${file.path}:${line} ${name}: ${measured} ${MEASURES[ruleName]} (limit ${LIMITS[ruleName]})`
    ))
    .join("\n");
}

function budgetRuleFailure(file: FileShape, rule: ShapeRule, budget: number, budgetPath: string): string | null {
  const measured = file.violations.filter((violation) => violation.rule === rule).length;
  if (measured === budget) return null;
  if (measured > budget) {
    return `${file.path} is over its ${rule} budget: ${measured} violations, budget ${budget}.\n`
      + `${violationLines(file, rule)}\n`
      + `Bring the code back within the limit. Don't raise ${budgetPath}.`;
  }
  const detail = violationLines(file, rule);
  return `${file.path} is under its ${rule} budget: ${measured} violations, budget ${budget}.\n`
    + (detail && `${detail}\n`)
    + `Set "${rule}" to ${measured} in ${budgetPath} to lock in the improvement.`;
}

function unbudgetedFailure(file: FileShape, budgetPath: string): string {
  return `${file.path} has violations and no budget.\n`
    + `${violationLines(file)}\n`
    + "Bring the code within the limits. Only if you moved these violations from a budgeted file, "
    + `move their counts to ${budgetPath}: ${JSON.stringify(countViolations(file.violations))}`;
}

function fileFailures(file: FileShape, raw: string | undefined): string[] {
  const budgetPath = `${BASELINE_DIR}/${budgetName(file.path)}`;
  if (raw === undefined) return file.violations.length > 0 ? [unbudgetedFailure(file, budgetPath)] : [];
  const budget = parseBudget(raw);
  if (!budget) {
    return [`${budgetPath} isn't a valid budget for ${file.path}. It must be JSON mapping rule names (${RULES.join(", ")}) to counts.`];
  }
  if (file.violations.length === 0) return [`${file.path} has no violations left. Delete ${budgetPath}.`];
  return RULES.flatMap((rule) => budgetRuleFailure(file, rule, budget[rule] ?? 0, budgetPath) ?? []);
}

/** What must change for the scanned files to match their budgets exactly; empty when they do. */
export function compareToBudgets(files: FileShape[], budgets: Map<string, string>): string[] {
  const scanned = new Set(files.map((file) => budgetName(file.path)));
  const orphans = [...budgets.keys()].filter((name) => !scanned.has(name)).map((name) => (
    `${BASELINE_DIR}/${name} names a file that isn't scanned: ${name.replace(/\.json$/, "").replaceAll("__", "/")}. `
    + "Delete the budget, or if the source moved, rename the budget to match its new path."
  ));
  return [...files.flatMap((file) => fileFailures(file, budgets.get(budgetName(file.path)))), ...orphans];
}
