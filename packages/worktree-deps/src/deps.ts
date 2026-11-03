import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInstall } from "./install-process.js";
import { lockfileFor } from "./lockfile.js";
import { dependencyFingerprint, PREPARED } from "./fingerprint.js";
import { checkDependencyDirs, localLinksMatch, localLinksMismatch } from "./links.js";
import { copyRejection, copyInto } from "./copy.js";
import { elapsed, firstLine } from "./notes.js";

// Internal test entry points; the package's public API stays in index.ts.
export { installCommandFor, npmInstallMatches } from "./lockfile.js";
export { dependencyFingerprint } from "./fingerprint.js";
export { copyDependencies } from "./copy.js";

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
  const invalidation = await preparationMismatch(path, prepared, fingerprint);
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

/** What each package manager last installed, which an install or a later change rewrites. */
const INSTALL_RECORDS = [".package-lock.json", ".modules.yaml", ".yarn-integrity", ".yarn-state.yml"];

/**
 * Identifies what's installed in a worktree, so results from checks can be
 * tied to it. Null when that can't be verified: the preparation isn't valid for
 * the current inputs, or `node_modules` exists with no lockfile pinning it.
 * Only reads. Doesn't hash `node_modules` itself, so a hand edit inside it goes
 * unnoticed; installs and package manager runs are what it detects.
 */
export async function preparedDependencyIdentity(path: string): Promise<string | null> {
  if (!lockfileFor(path)) return existsSync(join(path, "node_modules")) ? null : "no-dependencies";
  try {
    const fingerprint = await dependencyFingerprint(path);
    const prepared = await readFile(join(path, PREPARED), "utf8").catch(() => null);
    if (prepared !== fingerprint || await localLinksMismatch(path)) return null;
    const records = await Promise.all(INSTALL_RECORDS.map(file => readFile(join(path, "node_modules", file), "utf8").catch(() => null)));
    return createHash("sha256").update(JSON.stringify([fingerprint, records])).digest("hex");
  } catch {
    return null;
  }
}

async function preparationMismatch(path: string, prepared: string | null, fingerprint: string): Promise<string | null> {
  if (prepared === null) return "the preparation marker is missing or unreadable";
  if (prepared !== fingerprint) return "dependency inputs changed since preparation (package manifests, lockfiles, or package manager settings)";
  return localLinksMismatch(path);
}
