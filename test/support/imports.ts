import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";

/** One place a source file refers to another module. */
export interface ModuleRef {
  /** The module, or null when it isn't a string literal, as in `import(name)` or `import x = A.B`. */
  spec: string | null;
  /** An `import` or `export ... from` declaration, rather than `import()`, `require()`, `import("x").T` or `import x = ...`. */
  declaration: boolean;
  /** `import type` or `export type`: erased, so nothing runs at load. */
  typeOnly: boolean;
}

/** Parses a source file the way every check in test/ reads one: TypeScript, with JSX in `.tsx`. */
export function parseSource(source: string, file: string) {
  return parse(source, {
    sourceType: "module",
    createImportExpressions: true,
    plugins: /x$/.test(file) ? ["typescript", "jsx"] : ["typescript"],
  });
}

/** Every module reference in a file, in source order, parsed rather than pattern-matched. */
export function moduleRefs(file: string): ModuleRef[] {
  const ast = parseSource(readFileSync(file, "utf8"), file);
  const literal = (node: Node | null | undefined) => (node?.type === "StringLiteral" ? node.value : null);
  const found: { at: number; ref: ModuleRef }[] = [];
  const add = (node: Node, ref: ModuleRef) => found.push({ at: node.start ?? 0, ref });
  const visit = (node: Node) => {
    if (node.type === "ImportDeclaration") {
      add(node, { spec: literal(node.source), declaration: true, typeOnly: node.importKind === "type" });
    } else if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      if (node.source) add(node, { spec: literal(node.source), declaration: true, typeOnly: node.exportKind === "type" });
    } else if (node.type === "TSImportType") {
      add(node, { spec: literal(node.argument), declaration: false, typeOnly: true });
    } else if (node.type === "TSImportEqualsDeclaration") {
      const target = node.moduleReference;
      add(node, { spec: target.type === "TSExternalModuleReference" ? literal(target.expression) : null, declaration: false, typeOnly: node.importKind === "type" });
    } else if (node.type === "ImportExpression") {
      add(node, { spec: literal(node.source), declaration: false, typeOnly: false });
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
      add(node, { spec: literal(node.arguments[0]), declaration: false, typeOnly: false });
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (typeof child?.type === "string") visit(child);
      }
    }
  };
  visit(ast.program);
  // Babel's fields aren't in source order, so a type annotation can be walked after what follows it.
  return found.sort((a, b) => a.at - b.at).map(({ ref }) => ref);
}

/** Every module a file refers to by name, in any form. */
export function specifiers(file: string): string[] {
  return moduleRefs(file).flatMap((ref) => (ref.spec === null ? [] : [ref.spec]));
}

/**
 * How a package's sources break its import boundary: relative imports must stay
 * on files in the package, other modules must pass `allowed`, and every
 * reference must be a plain declaration so the check can see what loads.
 */
export function packageImportViolations(srcDir: string, allowed: (ref: ModuleRef) => boolean): string[] {
  const files = (readdirSync(srcDir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(srcDir, f));
  const known = new Set(files);
  return files.flatMap((file) => moduleRefs(file).flatMap((ref) => {
    const name = relative(srcDir, file);
    if (!ref.declaration || ref.spec === null) return [`${name} loads ${ref.spec ?? "a module"} outside an import declaration`];
    if (ref.spec.startsWith(".")) {
      return known.has(resolve(dirname(file), ref.spec.replace(/\.js$/, ".ts"))) ? [] : [`${name} imports outside the package: ${ref.spec}`];
    }
    return allowed(ref) ? [] : [`${name} imports "${ref.spec}"`];
  }));
}
