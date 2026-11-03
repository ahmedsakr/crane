import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lockfileFor, installedMismatch, type Lockfile } from "./lockfile.js";
import { dependencyFingerprint, PREPARED } from "./fingerprint.js";
import { checkDependencyDirs, localLinksMatch, retargetLinks } from "./links.js";
import { packageDirs } from "./package-dirs.js";

const run = promisify(execFile);

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
export async function copyRejection(from: string, to: string, lock: Lockfile, fingerprint: string): Promise<string | null> {
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
export async function copyInto(from: string, to: string, fingerprint: string, signal?: AbortSignal): Promise<string[]> {
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
 * Copy a directory tree, preserving symlinks, modes and timestamps. Uses the
 * system `cp`, which is several times faster than Node's `fs.cp` on trees as
 * large as node_modules, and copy-on-write clones where the filesystem has them.
 */
async function copyTree(src: string, dst: string, signal?: AbortSignal): Promise<void> {
  const attempts = copyFlags();
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

function copyFlags(): string[][] {
  if (process.platform === "linux") return [["-a", "--reflink=auto"], ["-a"]];
  if (process.platform === "darwin") return [["-a", "-c"], ["-a"]];
  return [];
}
