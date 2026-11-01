import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Expand literal workspace paths and directory globs without scanning node_modules.
 * @param {string} root
 * @param {string} pattern
 * @returns {string[]}
 */
function workspaceDirectories(root, pattern) {
  if (/[!{}\[\]]/.test(pattern)) throw new Error(`Unsupported workspace pattern: ${pattern}`);
  const parts = pattern.replace(/\/$/, "").split("/");
  /** @param {string} dir @param {number} index @returns {string[]} */
  function visit(dir, index) {
    const part = parts[index];
    if (part === undefined) return [dir];
    if (!part.includes("*") && !part.includes("?")) return visit(join(dir, part), index + 1);
    const matcher = new RegExp(`^${part.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    const children = readdirSync(dir, { withFileTypes: true }).filter(e =>
      e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".") && matcher.test(e.name),
    );
    return [
      ...(part === "**" ? visit(dir, index + 1) : []),
      ...children.flatMap(e => visit(join(dir, e.name), part === "**" ? index : index + 1)),
    ];
  }
  const directories = visit(root, 0);
  return /[*?]/.test(pattern) ? directories.filter(dir => existsSync(join(dir, "package.json"))) : directories;
}

/** Return packages whose installed link is missing, broken, copied, or points elsewhere.
 * @param {string} root
 * @returns {string[]}
 */
export function invalidWorkspaceLinks(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  /** @type {string[]} */
  const patterns = manifest.workspaces?.packages ?? manifest.workspaces ?? [];
  const directories = new Set(patterns.flatMap(pattern => workspaceDirectories(root, pattern)));
  const invalid = [];
  for (const directory of directories) {
    const { name } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (typeof name !== "string" || !name) throw new Error(`Workspace has no package name: ${directory}`);
    const link = join(root, "node_modules", name);
    try {
      if (lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(directory)) continue;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) throw error;
    }
    invalid.push(name);
  }
  return invalid.sort();
}

/** @param {string} root @param {(message: string) => void} report */
export function checkWorkspaceLinks(root, report = console.error) {
  try {
    const invalid = invalidWorkspaceLinks(root);
    if (invalid.length) {
      report(`Workspace links are missing or incorrect: ${invalid.join(", ")}.\nPlease run npm install in your checkout, then retry.`);
      return 1;
    }
    return 0;
  } catch (error) {
    report(`Cannot check workspace links: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Resolve from this script, so invocation does not depend on the shell's cwd.
  process.exitCode = checkWorkspaceLinks(fileURLToPath(new URL("../", import.meta.url)));
}
