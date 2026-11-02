import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runInstall } from "./install-process.js";

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
 * to install (no lockfile). Only
 * lockfile-driven installs, so the worktree gets exactly what the repo pins.
 */
export function installCommandFor(path: string): { cmd: string; args: string[] } | null {
  const lock = lockfileFor(path);
  if (!lock) return null;
  return { cmd: lock.cmd, args: lock.args };
}

export interface InstallDependenciesOptions {
  from?: string;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

/**
 * Get a worktree's dependencies in place so agents can build and test
 * without needing permission to install. Copies them from `from` (the repo's
 * own checkout) when that checkout has installed exactly what the worktree's
 * lockfile pins, since that skips downloads and native rebuilds. Otherwise runs
 * a clean, lockfile-driven install. Returns a note for the activity feed, or
 * null if nothing needed doing. Throws if the install fails.
 *
 * `onProgress` hears about the slow part (a copy or a clean install) before it
 * starts, including why the copy was skipped, so a long setup is explained
 * while it runs rather than after. The returned note carries the same reason
 * and how long the setup took. Installs also report elapsed time and bounded,
 * best-effort redacted stdout/stderr tails every 30 seconds and on completion.
 */
export async function installDependencies(
  path: string,
  opts: InstallDependenciesOptions = {},
): Promise<string | null> {
  const lock = lockfileFor(path);
  if (!lock) return null;
  await checkDependencyDirs(path);
  const fingerprint = await dependencyFingerprint(path);
  const prepared = await readFile(join(path, PREPARED), "utf8").catch(() => null);
  const invalidation = prepared === null
    ? "the preparation marker is missing or unreadable"
    : prepared !== fingerprint
      ? "dependency inputs changed since preparation (package manifests, lockfiles, or package manager settings)"
      : await localLinksMismatch(path);
  if (!invalidation) return null;
  const refresh = ` · preparation not reusable: ${invalidation}`;
  const started = Date.now();
  // A failed refresh must not leave a previous preparation marked as valid.
  await rm(join(path, PREPARED), { force: true });
  let skipped: string | null = null;
  if (opts.from) {
    try {
      skipped = await copyRejection(opts.from, path, lock, fingerprint);
      if (!skipped) {
        opts.onProgress?.(`Copying dependencies from your checkout${refresh}`);
        const copied = await copyInto(opts.from, path, fingerprint, opts.signal);
        return `Copied dependencies from your checkout (${copied.join(", ")}) in ${elapsed(Date.now() - started)}${refresh}`;
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Fall through: a clean install still gets the worktree what it needs.
      skipped = `copying failed: ${firstLine(err)}`;
    }
  }
  const command = [lock.cmd, ...lock.args].join(" ");
  const because = refresh + (skipped ? ` · didn't copy from your checkout: ${skipped}` : "");
  opts.onProgress?.(`Installing dependencies (${command})${because}`);
  await runInstall(lock.cmd, lock.args, {
    cwd: path,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
  if (!(await localLinksMatch(path))) throw new Error("Installed local package links do not point inside the worktree");
  // npm can omit node_modules entirely when the lock has no dependencies.
  await mkdir(join(path, "node_modules"), { recursive: true });
  await writeFile(join(path, PREPARED), fingerprint);
  return `Installed dependencies (${command}) in ${elapsed(Date.now() - started)}${because}`;
}

/** A short, readable duration for the activity feed: "0.4s", "12s", "2m 41s". */
function elapsed(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

// Kept under node_modules so it is untracked and disappears with the install.
const PREPARED = "node_modules/.crane-dependencies";

/** Refreshes must never follow a dependency directory back into another checkout. */
async function checkDependencyDirs(path: string): Promise<void> {
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

/** Include manifests as well as locks: workspace names/paths can change independently. */
export async function dependencyFingerprint(path: string): Promise<string> {
  const files = (await packageDirs(path)).flatMap(d =>
    ["package.json", ...LOCKFILES.map(l => l.file)].map(f => join(d, f)),
  );
  files.push("pnpm-workspace.yaml", ".npmrc", ".yarnrc.yml");
  const inputs = await Promise.all(files.sort().map(async (file): Promise<FingerprintInput> => {
    const contents = await readFile(join(path, file), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    return [file, contents];
  }));
  const hashed = lockfileFor(path)?.file === "package-lock.json" ? withoutBuildScripts(inputs) : inputs;
  return createHash("sha256").update(JSON.stringify(hashed)).digest("hex");
}

type FingerprintInput = [file: string, contents: string | null];

/** Build and dev entry points that nothing runs during an install, unless a hook below calls them. */
const BUILD_SCRIPT = /^(build|dev)(:.+)?$/;

/**
 * Everything `npm ci` runs from a project's own manifests. Any of these could
 * call a build script, so a build script's text is an install input when one exists.
 */
const INSTALL_HOOKS = new Set([
  "preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare",
  "predependencies", "dependencies", "postdependencies",
]);

/**
 * Drop build and dev scripts from the manifests so editing them keeps an install
 * reusable. Only for npm, whose hooks are listed above. Returns `inputs` untouched
 * if any manifest has an install hook or can't be read, because a hook in one
 * package can run another package's build. Everything else in a manifest still
 * counts, though parsing it means formatting alone no longer does.
 */
function withoutBuildScripts(inputs: FingerprintInput[]): FingerprintInput[] {
  const result: FingerprintInput[] = [];
  for (const [file, contents] of inputs) {
    const isManifest = file === "package.json" || file.endsWith("/package.json");
    const kept = contents !== null && isManifest ? manifestWithoutBuildScripts(contents) : contents;
    if (contents !== null && kept === null) return inputs;
    result.push([file, kept]);
  }
  return result;
}

/** The manifest without its build and dev scripts, or null when they can't safely be ignored. */
function manifestWithoutBuildScripts(contents: string): string | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isRecord(manifest)) return null;
  if (manifest.scripts === undefined) return JSON.stringify(manifest);
  if (!isRecord(manifest.scripts)) return null;
  const scripts = Object.entries(manifest.scripts);
  if (scripts.some(([name]) => INSTALL_HOOKS.has(name))) return null;
  const kept = scripts.filter(([name, script]) => !(typeof script === "string" && BUILD_SCRIPT.test(name)));
  const stripped: Record<string, unknown> = { ...manifest, scripts: Object.fromEntries(kept) };
  // A manifest that only had build scripts matches one that never had any.
  if (kept.length === 0) delete stripped.scripts;
  return JSON.stringify(stripped);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** npm records workspace/local links in the lockfile, including their exact destinations. */
async function localLinksMatch(path: string): Promise<boolean> {
  return await localLinksMismatch(path) === null;
}

/** Explain the same link verification used for reuse, without trusting a stale marker. */
async function localLinksMismatch(path: string): Promise<string | null> {
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

/**
 * Copy `node_modules` (the root's and every workspace package's) from `from`
 * into the worktree at `to`. Returns the directories copied, relative to the
 * worktree as `copied`, or, as `skipped`, why `from` can't be trusted to match
 * the worktree's lockfile. It's a real copy, never a link, so nothing run in
 * the worktree can change the operator's checkout. On failure, removes
 * whatever it copied and throws.
 */
export async function copyDependencies(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<{ copied: string[] } | { skipped: string }> {
  const lock = lockfileFor(to);
  if (!lock) return { skipped: "the worktree has no lockfile" };
  const fingerprint = await dependencyFingerprint(to);
  const skipped = await copyRejection(from, to, lock, fingerprint);
  return skipped ? { skipped } : { copied: await copyInto(from, to, fingerprint, signal) };
}

/**
 * Why `from`'s installed dependencies can't be copied into `to`, phrased to
 * follow "didn't copy from your checkout:", or null when they can. Only reads.
 */
async function copyRejection(from: string, to: string, lock: Lockfile, fingerprint: string): Promise<string | null> {
  if (existsSync(join(to, "node_modules"))) return "the worktree already has node_modules";
  if (!existsSync(join(from, "node_modules"))) return "it has no node_modules";
  await checkDependencyDirs(to);
  await checkDependencyDirs(from);
  const mismatch = await installedMismatch(from, to, lock);
  if (mismatch) return mismatch;
  if (fingerprint !== await dependencyFingerprint(from)) {
    return "its package.json files or package manager settings differ from the worktree's";
  }
  if (!(await localLinksMatch(from))) return "its local package links don't point inside it";
  const prepared = await readFile(join(from, PREPARED), "utf8").catch(() => null);
  if (prepared !== null && prepared !== fingerprint) return "its install predates its current package.json files";
  return null;
}

/** The copy itself, once `copyRejection` has cleared it. */
async function copyInto(from: string, to: string, fingerprint: string, signal?: AbortSignal): Promise<string[]> {
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
    if (!(await localLinksMatch(to))) throw new Error("Copied local package links do not point inside the worktree");
    await writeFile(join(to, PREPARED), fingerprint);
  } catch (err) {
    for (const dst of created) await rm(dst, { recursive: true, force: true });
    throw err;
  }
  return dirs.map((d) => (d ? `${d}/node_modules` : "node_modules"));
}

/**
 * Why `from` hasn't installed exactly what the worktree's lockfile pins, or
 * null when it has: the lockfiles must be identical and, for npm,
 * `node_modules/.package-lock.json` (what npm last installed) must agree with
 * it, so a checkout that pulled a new lockfile but never reinstalled isn't copied.
 */
async function installedMismatch(from: string, to: string, lock: Lockfile): Promise<string | null> {
  const theirs = join(from, lock.file);
  if (!existsSync(theirs)) return `it has no ${lock.file}`;
  const [mine, source] = await Promise.all([readFile(join(to, lock.file)), readFile(theirs)]);
  if (!mine.equals(source)) return `its ${lock.file} differs from the worktree's`;
  if (lock.file !== "package-lock.json") return null;
  let hidden: NpmLock;
  try {
    hidden = JSON.parse(await readFile(join(from, "node_modules", ".package-lock.json"), "utf8"));
  } catch {
    return "it has no readable record of what npm installed (node_modules/.package-lock.json)";
  }
  try {
    if (npmInstallMatches(JSON.parse(source.toString("utf8")), hidden)) return null;
  } catch {
    return `its ${lock.file} isn't valid JSON`;
  }
  return "what it has installed doesn't match its package-lock.json (run npm install there)";
}

type NpmLock = { packages?: Record<string, { version?: string; optional?: boolean; link?: boolean; resolved?: string }> };

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
    const pin = pinned[key];
    if (!pin || pin.version !== pkg.version || pin.link !== pkg.link) return false;
    if (pkg.link && pin.resolved !== pkg.resolved) return false;
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
