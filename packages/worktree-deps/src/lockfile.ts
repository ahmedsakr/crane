import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Lockfile {
  file: string;
  cmd: string;
  args: string[];
}

export const LOCKFILES: Lockfile[] = [
  { file: "package-lock.json", cmd: "npm", args: ["ci", "--no-audit", "--no-fund"] },
  { file: "pnpm-lock.yaml", cmd: "pnpm", args: ["install", "--frozen-lockfile"] },
  { file: "yarn.lock", cmd: "yarn", args: ["install", "--frozen-lockfile"] },
];

export function lockfileFor(path: string): Lockfile | null {
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

/**
 * Why `from` hasn't installed exactly what the worktree's lockfile pins, or
 * null when it has: the lockfiles must be identical and, for npm,
 * `node_modules/.package-lock.json` (what npm last installed) must agree with
 * it, so a checkout that pulled a new lockfile but never reinstalled isn't copied.
 */
export async function installedMismatch(from: string, to: string, lock: Lockfile): Promise<string | null> {
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

export type NpmLock = { packages?: Record<string, { version?: string; optional?: boolean; link?: boolean; resolved?: string }> };

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
