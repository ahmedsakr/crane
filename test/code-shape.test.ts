import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASELINE_DIR,
  budgetName,
  compareToBudgets,
  inspectSource,
  readBudgets,
  scanTree,
  sourcePaths,
  type ShapeRule,
} from "./support/code-shape.ts";
import { moduleRefs } from "./support/imports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function found(source: string, rule: ShapeRule, path = "src/sample.tsx") {
  return inspectSource(path, source).violations.filter((violation) => violation.rule === rule);
}

function measured(source: string, rule: ShapeRule, path?: string): number[] {
  return found(source, rule, path).map((violation) => violation.measured);
}

function statements(count: number): string {
  return Array.from({ length: count }, (_, index) => `  call(${index});`).join("\n");
}

function nestedIfs(levels: number): string {
  return `${"if (a) {\n".repeat(levels)}call();\n${"}\n".repeat(levels)}`;
}

const params = (count: number) => Array.from({ length: count }, (_, index) => `p${index}`).join(", ");

// A file over budget, used by the ratchet tests: two nested ternaries in one function.
const OVER_LIMIT = "export function pick(a, b, c) {\n  return a ? 1 : b ? 2 : c ? 3 : 4;\n}\n";

test("the tree matches its budgets exactly", () => {
  const failures = compareToBudgets(scanTree(ROOT), readBudgets(join(ROOT, BASELINE_DIR)));
  assert.equal(failures.length, 0, `\n${failures.join("\n\n")}\n`);
});

test("the guard only reads files: no sockets or child processes", () => {
  const allowed = new Set(["node:assert/strict", "node:fs", "node:os", "node:path", "node:test", "node:url", "@babel/parser", "@babel/types"]);
  const files = ["test/code-shape.test.ts", "test/support/code-shape.ts", "test/support/imports.ts"];
  const outside = files.flatMap((file) => moduleRefs(join(ROOT, file)))
    .flatMap((ref) => (ref.spec === null || ref.spec.startsWith("./") || allowed.has(ref.spec) ? [] : [ref.spec]));
  assert.deepEqual(outside, []);
});

test("nestedTernary finds a ternary inside another in any branch", () => {
  assert.deepEqual(measured("const x = a ? b : c ? d : e;", "nestedTernary"), [2]);
  assert.deepEqual(measured("const x = a ? (b ? 1 : 2) : 3;", "nestedTernary"), [2]);
  assert.deepEqual(measured("const x = (a ? b : c) ? d : e;", "nestedTernary"), [2]);
  assert.deepEqual(measured("const x = a ? 1 : b ? 2 : c ? 3 : 4;", "nestedTernary"), [2, 3]);
});

test("nestedTernary sees through JSX, template literals, and other expressions", () => {
  assert.equal(found("const x = a ? <div>{b ? 1 : 2}</div> : null;", "nestedTernary").length, 1);
  assert.equal(found("const x = a ? <div title={b ? 'y' : 'n'} /> : null;", "nestedTernary").length, 1);
  assert.equal(found("const x = a ? `one ${b ? 1 : 2}` : 'two';", "nestedTernary").length, 1);
  assert.equal(found("const x = a ? { key: [call(b ? 1 : 2)] } : null;", "nestedTernary").length, 1);
});

test("nestedTernary allows sequential ternaries and ternaries in separate callbacks", () => {
  assert.deepEqual(found("const x = a ? 1 : 2;\nconst y = b ? 3 : 4;", "nestedTernary"), []);
  assert.deepEqual(found("call(a ? 1 : 2, b ? 3 : 4);", "nestedTernary"), []);
  assert.deepEqual(found("const x = <div>{a ? 1 : 2}{b ? 3 : 4}</div>;", "nestedTernary"), []);
  assert.deepEqual(found("const x = a ? b.map((v) => (v ? 1 : 2)) : c.map((v) => (v ? 3 : 4));", "nestedTernary"), []);
  assert.deepEqual(found("const x = a ? function () { return b ? 1 : 2; } : null;", "nestedTernary"), []);
});

test("nestedTernary still applies inside a callback, and ignores conditional types", () => {
  const [violation] = found("const x = a ? list.map((v) => (v ? 1 : w ? 2 : 3)) : [];", "nestedTernary");
  assert.deepEqual(violation, { rule: "nestedTernary", line: 1, name: "map callback", measured: 2 });
  assert.deepEqual(found("type T<A> = A extends string ? 1 : A extends number ? 2 : 3;", "nestedTernary"), []);
});

test("functionLines counts code lines and allows exactly the limit", () => {
  assert.deepEqual(found(`function ok() {\n${statements(58)}\n}`, "functionLines"), []);
  assert.deepEqual(found(`function long() {\n${statements(59)}\n}`, "functionLines"), [
    { rule: "functionLines", line: 1, name: "long", measured: 61 },
  ]);
});

test("functionLines excludes blank and comment-only lines, but not code beside a comment", () => {
  const padding = "\n\n// a note\n/* a block\n   over lines */\n";
  assert.deepEqual(found(`function ok() {${padding}\n${statements(58)}\n}`, "functionLines"), []);
  assert.deepEqual(measured(`function long() {\n${statements(58)}\n  call(); // note\n}`, "functionLines"), [61]);
  const jsxNotes = "      {/* a note */}\n".repeat(10);
  const page = `function Page() {\n  return (\n    <div>\n${jsxNotes}${"      <br />\n".repeat(54)}    </div>\n  );\n}`;
  assert.deepEqual(found(page, "functionLines"), []);
});

test("functionLines keeps comment-like text in a string as code", () => {
  const text = `function long() {\n  return \`\n${"// not a comment\n".repeat(59)}\`;\n}`;
  assert.deepEqual(measured(text, "functionLines"), [63]);
});

test("functionLines names functions by how they are declared", () => {
  const body = statements(61);
  const names = (source: string) => found(source, "functionLines").map((violation) => violation.name);
  assert.deepEqual(names(`const arrow = () => {\n${body}\n};`), ["arrow"]);
  assert.deepEqual(names(`class Store {\n  method() {\n${body}\n  }\n}`), ["Store.method"]);
  assert.deepEqual(names(`class Store {\n  field = () => {\n${body}\n  };\n}`), ["Store.field"]);
  assert.deepEqual(names(`const o = {\n  method() {\n${body}\n  },\n};`), ["method"]);
  assert.deepEqual(names(`export default () => {\n${body}\n};`), ["default"]);
  assert.deepEqual(names(`app.get("/x", () => {\n${body}\n});`), ["get callback"]);
  assert.deepEqual(names(`const x = <a onClick={() => {\n${body}\n}} />;`), ["onClick"]);
  assert.deepEqual(names(`(() => {\n${body}\n})();`), ["<anonymous>"]);
});

test("parameters allows exactly the limit and doesn't count a typed this", () => {
  assert.deepEqual(found(`function ok(${params(5)}) {}`, "parameters"), []);
  assert.deepEqual(found(`function ok(this: Store, ${params(5)}) {}`, "parameters"), []);
  assert.deepEqual(found(`function ok({ a, b, c, d, e, f, g }) {}`, "parameters"), []);
  assert.deepEqual(found(`function many(${params(6)}) {}`, "parameters"), [
    { rule: "parameters", line: 1, name: "many", measured: 6 },
  ]);
  assert.deepEqual(measured(`const f = (${params(5)}, ...rest) => {};`, "parameters"), [6]);
  assert.deepEqual(measured(`class A { constructor(private a, ${params(5)}) {} }`, "parameters"), [6]);
});

test("depth counts every block type and allows exactly the limit", () => {
  assert.deepEqual(found(`function ok() {\n${nestedIfs(4)}}`, "depth"), []);
  assert.deepEqual(measured(`function deep() {\n${nestedIfs(5)}}`, "depth"), [5]);
  assert.deepEqual(measured(`function deep() {\n${nestedIfs(6)}}`, "depth"), [5, 6]);
  const mixed = "function deep() {\nfor (;;) { for (a of b) { for (a in b) { while (a) { do { switch (a) { default: try { call(); } catch {} } } while (a); } } } }\n}";
  assert.deepEqual(measured(mixed, "depth"), [5, 6, 7]);
});

test("depth treats else-if as the same level, and resets inside a function", () => {
  const chain = `function ok() {\nif (a) {} ${"else if (b) {} ".repeat(8)}\n}`;
  assert.deepEqual(found(chain, "depth"), []);
  assert.deepEqual(measured(`function deep() {\nif (a) {} else { ${nestedIfs(5)} }\n}`, "depth"), [5, 6]);
  const callback = `${"if (a) {\n".repeat(4)}list.map(() => {\n${nestedIfs(4)}});\n${"}\n".repeat(4)}`;
  assert.deepEqual(found(callback, "depth"), []);
});

test("fileLines counts physical lines and allows exactly the limit", () => {
  assert.deepEqual(found("call();\n".repeat(500), "fileLines"), []);
  assert.deepEqual(found("call();\n".repeat(501), "fileLines"), [
    { rule: "fileLines", line: 1, name: "<file>", measured: 501 },
  ]);
  assert.deepEqual(measured("\n".repeat(501), "fileLines"), [501]);
});

test("test suites follow only the ternary rule; support files and scripts follow them all", () => {
  const source = `function many(${params(6)}) {\n${statements(60)}\n${nestedIfs(5)}\nreturn a ? 1 : b ? 2 : 3;\n}\n${"\n".repeat(500)}`;
  const rules = (path: string) => [...new Set(inspectSource(path, source).violations.map((violation) => violation.rule))].sort();
  assert.deepEqual(rules("test/sample.test.ts"), ["nestedTernary"]);
  const all = ["depth", "fileLines", "functionLines", "nestedTernary", "parameters"];
  assert.deepEqual(rules("test/support/sample.ts"), all);
  assert.deepEqual(rules("scripts/sample.mjs"), all);
  assert.deepEqual(rules("src/sample.ts"), all);
});

test("a source file that can't be parsed fails naming the file", () => {
  assert.throws(() => inspectSource("src/broken.ts", "const = ;"), /src\/broken\.ts/);
});

test("the scan covers source directories and skips dist, node_modules, and other files", () => {
  const root = mkdtempSync(join(tmpdir(), "crane-code-shape-"));
  try {
    const files = [
      "src/a.ts", "src/deep/b.tsx", "web/src/c.tsx", "packages/one/src/d.ts", "scripts/e.mjs", "test/f.test.ts", "test/support/g.ts",
      "src/notes.md", "src/dist/h.ts", "src/node_modules/i.ts", "web/j.ts", "packages/one/dist/k.ts", "packages/one/l.ts", "m.ts",
    ];
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    assert.deepEqual(sourcePaths(root), [
      "packages/one/src/d.ts", "scripts/e.mjs", "src/a.ts", "src/deep/b.tsx", "test/f.test.ts", "test/support/g.ts", "web/src/c.tsx",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("budgets are named from the source path", () => {
  assert.equal(budgetName("src/core/store.ts"), "src__core__store.ts.json");
});

test("no budget: a file with no violations passes", () => {
  assert.deepEqual(compareToBudgets([inspectSource("src/clean.ts", "export const a = 1;\n")], new Map()), []);
});

test("a matching budget passes, in any key order", () => {
  const file = inspectSource("src/pick.ts", OVER_LIMIT);
  assert.deepEqual(compareToBudgets([file], new Map([["src__pick.ts.json", '{ "nestedTernary": 2 }']])), []);
});

test("an unbudgeted violation fails naming the file, location, value, limit, and what to do", () => {
  const [failure, ...rest] = compareToBudgets([inspectSource("src/pick.ts", OVER_LIMIT)], new Map());
  assert.deepEqual(rest, []);
  assert.match(failure!, /src\/pick\.ts has violations and no budget/);
  assert.match(failure!, /src\/pick\.ts:2 pick: 2 ternary nesting level \(limit 1\)/);
  assert.match(failure!, /src\/pick\.ts:2 pick: 3 ternary nesting level \(limit 1\)/);
  assert.match(failure!, /Bring the code within the limits/);
  assert.match(failure!, /test\/support\/code-shape-baseline\/src__pick\.ts\.json: \{"nestedTernary":2\}/);
});

test("a file over its budget fails and says not to raise it", () => {
  const budgets = new Map([["src__pick.ts.json", '{ "nestedTernary": 1 }']]);
  const [failure, ...rest] = compareToBudgets([inspectSource("src/pick.ts", OVER_LIMIT)], budgets);
  assert.deepEqual(rest, []);
  assert.match(failure!, /src\/pick\.ts is over its nestedTernary budget: 2 violations, budget 1/);
  assert.match(failure!, /src\/pick\.ts:2 pick: 3 ternary nesting level \(limit 1\)/);
  assert.match(failure!, /Don't raise test\/support\/code-shape-baseline\/src__pick\.ts\.json/);
});

test("a file under its budget fails and says what to lower", () => {
  const budgets = new Map([["src__pick.ts.json", '{ "nestedTernary": 2, "depth": 1 }']]);
  const [failure, ...rest] = compareToBudgets([inspectSource("src/pick.ts", OVER_LIMIT)], budgets);
  assert.deepEqual(rest, []);
  assert.match(failure!, /src\/pick\.ts is under its depth budget: 0 violations, budget 1/);
  assert.match(failure!, /Set "depth" to 0 in test\/support\/code-shape-baseline\/src__pick\.ts\.json/);
});

test("a file with no violations left must delete its budget", () => {
  const budgets = new Map([["src__clean.ts.json", '{ "depth": 1 }']]);
  assert.deepEqual(compareToBudgets([inspectSource("src/clean.ts", "export const a = 1;\n")], budgets), [
    "src/clean.ts has no violations left. Delete test/support/code-shape-baseline/src__clean.ts.json.",
  ]);
  assert.equal(compareToBudgets([inspectSource("src/clean.ts", "")], new Map([["src__clean.ts.json", "{}"]])).length, 1);
});

test("a budget for a missing file fails naming the file and what to change", () => {
  const [failure, ...rest] = compareToBudgets([], new Map([["src__core__gone.ts.json", '{ "depth": 1 }']]));
  assert.deepEqual(rest, []);
  assert.match(failure!, /src__core__gone\.ts\.json names a file that isn't scanned: src\/core\/gone\.ts/);
  assert.match(failure!, /Delete the budget/);
});

test("a malformed budget fails naming the file", () => {
  const file = inspectSource("src/pick.ts", OVER_LIMIT);
  for (const raw of ["not json", "[]", "null", '{ "unknownRule": 1 }', '{ "depth": -1 }', '{ "depth": 1.5 }', '{ "depth": "1" }']) {
    const [failure, ...rest] = compareToBudgets([file], new Map([["src__pick.ts.json", raw]]));
    assert.deepEqual(rest, []);
    assert.match(failure!, /src__pick\.ts\.json isn't a valid budget for src\/pick\.ts/, raw);
  }
});
