import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Node } from "@babel/types";
import { parseSource } from "./imports.ts";

export const RULES = ["nestedTernary", "functionLines", "parameters", "depth", "fileLines"] as const;
export type ShapeRule = (typeof RULES)[number];

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

/** One line per violation: where it is, what it measured, and the limit. Empty when the files are clean. */
export function shapeFailures(files: FileShape[]): string[] {
  return files.flatMap((file) => file.violations.map(({ rule, line, name, measured }) => (
    `${file.path}:${line} ${name}: ${measured} ${MEASURES[rule]} (limit ${LIMITS[rule]})`
  )));
}
