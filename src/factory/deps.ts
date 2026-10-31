import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, existsSync } from "node:fs";
import { cp, readFile, readdir, readlink, realpath, rm, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "./git.js";

const run = promisify(execFile);

interface Lockfile {
  file: string;
  cmd: string;
  args: string[];
}

const LOCKFILES: Lockfile[] = [
  { file: "package-lock.json", cmd: "npm", args: ["ci", "--no-audit", "--no-fund"] },
  { file: "pnpm-lock.yaml", cmd: "pnpm", args: ["install", "--frozen-lockfile"] },
  { file: "yarn.lock", cmd: "yarn", args: ["install", "--frozen-lockfile"] },
];

function lockfileFor(path: string): Lockfile | null {
  if (!existsSync(join(path, "package.json"))) return null;
  return LOCKFILES.find((l) => existsSync(join(path, l.file))) ?? null;
}

/**
 * The install command for a worktree's lockfile, or null when there is nothing
 * to install (no lockfile, or dependencies are already in place). Only
 * lockfile-driven installs, so the worktree gets exactly what the repo pins.
 */
export function installCommandFor(path: string): { cmd: string; args: string[] } | null {
  const lock = lockfileFor(path);
  if (!lock || existsSync(join(path, "node_modules"))) return null;
  return { cmd: lock.cmd, args: lock.args };
}

/**
 * Get a fresh worktree's dependencies in place so agents can build and test
 * without needing permission to install. Copies them from `from` (the repo's
 * own checkout) when that checkout has installed exactly what the worktree's
 * lockfile pins, since that skips downloads and native rebuilds. Otherwise runs
 * a clean, lockfile-driven install. Returns a note for the activity feed, or
 * null if nothing needed doing. Throws if the install fails.
 */
export async function installDependencies(
  path: string,
  opts: { from?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (opts.from) {
    try {
      const copied = await copyDependencies(opts.from, path, opts.signal);
      if (copied) return `Copied dependencies from your checkout (${copied.join(", ")})`;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Fall through: a clean install still gets the worktree what it needs.
    }
  }
  const install = installCommandFor(path);
  if (!install) return null;
  await run(install.cmd, install.args, {
    cwd: path,
    signal: opts.signal,
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return `Installed dependencies (${[install.cmd, ...install.args].join(" ")})`;
}

/**
 * Copy `node_modules` (the root's and every workspace package's) from `from`
 * into the worktree at `to`. Returns the directories copied, relative to the
 * worktree, or null when `from` can't be trusted to match the worktree's
 * lockfile. It's a real copy, never a link, so nothing run in the worktree can
 * change the operator's checkout. On failure, removes whatever it copied.
 */
export async function copyDependencies(from: string, to: string, signal?: AbortSignal): Promise<string[] | null> {
  const lock = lockfileFor(to);
  if (!lock || existsSync(join(to, "node_modules")) || !existsSync(join(from, "node_modules"))) return null;
  if (!(await installedMatches(from, to, lock))) return null;

  const dirs = (await packageDirs(to)).filter(
    (d) => existsSync(join(from, d, "node_modules")) && !existsSync(join(to, d, "node_modules")),
  );
  const created: string[] = [];
  try {
    for (const d of dirs) {
      const dst = join(to, d, "node_modules");
      created.push(dst);
      await copyTree(join(from, d, "node_modules"), dst, signal);
      await retargetLinks(dst, from, to);
    }
  } catch (err) {
    for (const dst of created) await rm(dst, { recursive: true, force: true });
    throw err;
  }
  return dirs.map((d) => (d ? `${d}/node_modules` : "node_modules"));
}

/**
 * Whether `from` has installed exactly what the worktree's lockfile pins: the
 * lockfiles must be identical and, for npm, `node_modules/.package-lock.json`
 * (what npm last installed) must agree with it, so a checkout that pulled a new
 * lockfile but never reinstalled isn't copied.
 */
async function installedMatches(from: string, to: string, lock: Lockfile): Promise<boolean> {
  const theirs = join(from, lock.file);
  if (!existsSync(theirs)) return false;
  const [mine, source] = await Promise.all([readFile(join(to, lock.file)), readFile(theirs)]);
  if (!mine.equals(source)) return false;
  if (lock.file !== "package-lock.json") return true;
  try {
    const hidden = JSON.parse(await readFile(join(from, "node_modules", ".package-lock.json"), "utf8"));
    return npmInstallMatches(JSON.parse(source.toString("utf8")), hidden);
  } catch {
    return false;
  }
}

type NpmLock = { packages?: Record<string, { version?: string; optional?: boolean }> };

/**
 * Compare a package-lock.json with npm's hidden lockfile. Every installed
 * package must be pinned at the same version, and every pinned package must be
 * installed, except optional ones (usually binaries for other platforms).
 */
export function npmInstallMatches(lock: NpmLock, hidden: NpmLock): boolean {
  const pinned = lock.packages;
  const installed = hidden.packages;
  if (!pinned || !installed) return false;
  for (const [key, pkg] of Object.entries(installed)) {
    if (pinned[key]?.version !== pkg.version) return false;
  }
  for (const [key, pkg] of Object.entries(pinned)) {
    if (key === "" || pkg.optional || !key.includes("node_modules/")) continue;
    if (!(key in installed)) return false;
  }
  return true;
}

/** The worktree's package directories ("" for the root), from the package.json files git tracks. */
async function packageDirs(path: string): Promise<string[]> {
  let files: string[] = [];
  try {
    files = (await git(path, "ls-files", "-z", "--", "package.json", "*/package.json")).split("\0").filter(Boolean);
  } catch {
    // Not a git checkout: just the root.
  }
  const dirs = files
    .filter((f) => !f.split("/").includes("node_modules"))
    .map((f) => (f === "package.json" ? "" : f.slice(0, -"/package.json".length)));
  return [...new Set(["", ...dirs])];
}

/**
 * Copy a directory tree, preserving symlinks, modes and timestamps. Uses the
 * system `cp`, which is several times faster than Node's `fs.cp` on trees as
 * large as node_modules, and copy-on-write clones where the filesystem has them.
 */
async function copyTree(src: string, dst: string, signal?: AbortSignal): Promise<void> {
  const attempts =
    process.platform === "linux"
      ? [["-a", "--reflink=auto"], ["-a"]]
      : process.platform === "darwin"
        ? [["-a", "-c"], ["-a"]]
        : [];
  for (const flags of attempts) {
    try {
      await run("cp", [...flags, src, dst], { signal, maxBuffer: 16 * 1024 * 1024 });
      return;
    } catch (err) {
      await rm(dst, { recursive: true, force: true });
      if (signal?.aborted) throw err;
    }
  }
  signal?.throwIfAborted();
  await cp(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Point any symlink in the copied tree that leads into the operator's checkout
 * at the same place in the worktree instead, so the copy is fully detached.
 * Package managers mostly write relative links, which already resolve inside
 * the worktree, but a stray absolute one would otherwise reach back.
 */
async function retargetLinks(dir: string, from: string, to: string): Promise<void> {
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
