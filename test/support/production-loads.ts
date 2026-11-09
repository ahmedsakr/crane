import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { moduleRefs } from "./imports.ts";

/** Resolve workspace exports to their source, so eager-load checks cross package boundaries. */
function workspaceSource(root: string, spec: string): string | null {
  if (!spec.startsWith("@crane/")) return null;
  const [, name, ...subpath] = spec.split("/");
  const dir = join(root, "packages", name!);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const key = subpath.length ? `./${subpath.join("/")}` : ".";
  const entry = manifest.exports[key]?.default;
  if (!entry) throw new Error(`Unknown workspace entry ${spec}`);
  return resolve(dir, entry.replace("./dist/", "./src/").replace(/\.js$/, ".ts"));
}

export function eagerProductionLoads(root: string, entry: string): string[] {
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const ref of moduleRefs(file)) {
      if (!ref.declaration || ref.typeOnly || ref.spec === null) continue;
      const target = ref.spec.startsWith(".")
        ? resolve(dirname(file), ref.spec.replace(/\.js$/, ".ts")) : workspaceSource(root, ref.spec);
      if (target) visit(target);
    }
  };
  visit(join(root, entry));
  return [...visited].map((file) => relative(root, file)).sort();
}
