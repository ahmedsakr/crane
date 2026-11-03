import { lstat, readFile, readdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lockfileFor, type NpmLock } from "./lockfile.js";
import { packageDirs } from "./package-dirs.js";
import { firstLine } from "./notes.js";

/** Refreshes must never follow a dependency directory back into another checkout. */
export async function checkDependencyDirs(path: string): Promise<void> {
  const root = await realpath(path);
  for (const dir of await packageDirs(path)) {
    const packagePath = await realpath(join(path, dir)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (packagePath && !within(root, packagePath)) throw new Error(`Package directory must stay inside the worktree: ${dir}`);
    const modules = join(path, dir, "node_modules");
    const stat = await lstat(modules).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (stat && (stat.isSymbolicLink() || !within(root, await realpath(modules)))) {
      throw new Error(`Dependency directory must stay inside the worktree: ${modules}`);
    }
  }
}

/** npm records workspace/local links in the lockfile, including their exact destinations. */
export async function localLinksMatch(path: string): Promise<boolean> {
  return await localLinksMismatch(path) === null;
}

/** Explain the same link verification used for reuse, without trusting a stale marker. */
export async function localLinksMismatch(path: string): Promise<string | null> {
  if (lockfileFor(path)?.file !== "package-lock.json") return null;
  try {
    const root = await realpath(path);
    const lock: NpmLock = JSON.parse(await readFile(join(path, "package-lock.json"), "utf8"));
    if (!lock.packages) return null; // npm v1 locks have no workspace link entries.
    for (const [file, pkg] of Object.entries(lock.packages)) {
      if (!pkg.link) continue;
      if (!pkg.resolved || !file.includes("node_modules/")) return `invalid local package link entry: ${file}`;
      const expected = resolve(root, pkg.resolved);
      if (!within(root, expected)) return `local package link ${file} resolves outside the worktree`;
      try {
        const [target, linked] = await Promise.all([realpath(expected), realpath(join(root, file))]);
        if (!within(root, target) || target !== linked) return `local package link ${file} does not point to ${pkg.resolved} inside the worktree`;
      } catch (err) {
        return `local package link ${file} or its target ${pkg.resolved} is missing or unreadable: ${firstLine(err)}`;
      }
    }
    return null;
  } catch (err) {
    return `could not verify local package links: ${firstLine(err)}`;
  }
}

const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Point any symlink in the copied tree that leads into the operator's checkout
 * at the same place in the worktree instead, so the copy is fully detached.
 * Package managers mostly write relative links, which already resolve inside
 * the worktree, but a stray absolute one would otherwise reach back.
 */
export async function retargetLinks(dir: string, from: string, to: string): Promise<void> {
  const [src, dst] = await Promise.all([realpath(from), realpath(to)]);
  const roots = [...new Set([from, src])];
  const visit = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true });
    await Promise.all(
      entries.map(async (e) => {
        const p = join(d, e.name);
        if (e.isDirectory()) return visit(p);
        if (!e.isSymbolicLink()) return;
        const target = await readlink(p);
        const abs = isAbsolute(target) ? target : resolve(d, target);
        if (within(to, abs) || within(dst, abs)) return;
        const root = roots.find((r) => within(r, abs));
        if (!root) return;
        const moved = join(to, relative(root, abs));
        await unlink(p);
        await symlink(relative(dirname(p), moved) || ".", p);
      }),
    );
  };
  await visit(dir);
}
