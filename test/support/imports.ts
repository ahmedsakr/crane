import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** One place a source file refers to another module. */
export interface ModuleRef {
  /** The module, or null when it isn't a string literal, as in `import(name)` or `import x = A.B`. */
  spec: string | null;
  /** An `import` or `export ... from` declaration, rather than `import()`, `require()`, `import("x").T` or `import x = ...`. */
  declaration: boolean;
  /** `import type` or `export type`: erased, so nothing runs at load. */
  typeOnly: boolean;
}

/** Every module reference in a file, in source order, parsed rather than pattern-matched. */
export function moduleRefs(file: string): ModuleRef[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const literal = (node: ts.Node | undefined) => (node && ts.isStringLiteral(node) ? node.text : null);
  const refs: ModuleRef[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      refs.push({ spec: literal(node.moduleSpecifier), declaration: true, typeOnly: node.importClause?.isTypeOnly ?? false });
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) refs.push({ spec: literal(node.moduleSpecifier), declaration: true, typeOnly: node.isTypeOnly });
    } else if (ts.isImportTypeNode(node)) {
      refs.push({ spec: ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : null, declaration: false, typeOnly: true });
    } else if (ts.isImportEqualsDeclaration(node)) {
      const target = node.moduleReference;
      refs.push({ spec: ts.isExternalModuleReference(target) ? literal(target.expression) : null, declaration: false, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      refs.push({ spec: literal(node.arguments[0]), declaration: false, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
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
