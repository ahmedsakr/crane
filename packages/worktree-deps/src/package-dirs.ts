import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The worktree's package directories ("" for the root), from the package.json files git tracks. */
export async function packageDirs(path: string): Promise<string[]> {
  let files: string[] = [];
  try {
    const { stdout } = await run("git", ["ls-files", "-z", "--", "package.json", "*/package.json"], {
      cwd: path,
      maxBuffer: 16 * 1024 * 1024,
    });
    files = stdout.trim().split("\0").filter(Boolean);
  } catch {
    // Not a git checkout: just the root.
  }
  const dirs = files
    .filter((f) => !f.split("/").includes("node_modules"))
    .map((f) => (f === "package.json" ? "" : f.slice(0, -"/package.json".length)));
  return [...new Set(["", ...dirs])];
}
