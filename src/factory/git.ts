import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { worktreesDir } from "../core/paths.js";
import { slugify } from "../core/ids.js";
import type { Mission, Repo } from "../core/types.js";

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, "rev-parse", "--is-inside-work-tree")) === "true";
  } catch {
    return false;
  }
}

export async function repoRoot(path: string): Promise<string> {
  return git(path, "rev-parse", "--show-toplevel");
}

export async function currentBranch(path: string): Promise<string> {
  try {
    const ref = await git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    return ref.replace(/^origin\//, "");
  } catch {
    try {
      return (await git(path, "rev-parse", "--abbrev-ref", "HEAD")) || "main";
    } catch {
      return "main";
    }
  }
}

export function branchFor(mission: Mission): string {
  return `crane/${slugify(mission.title, 32)}-${mission.id.slice(2)}`;
}

/** Give a mission its own branch and working directory so agents never touch the operator's checkout. */
export async function createWorktree(repo: Repo, mission: Mission): Promise<{ branch: string; path: string }> {
  const branch = branchFor(mission);
  const path = join(worktreesDir(), mission.id);
  if (!existsSync(path)) {
    let base = repo.defaultBranch;
    try {
      await git(repo.path, "rev-parse", "--verify", base);
    } catch {
      base = "HEAD";
    }
    await git(repo.path, "worktree", "add", "-b", branch, path, base);
  }
  return { branch, path };
}

/**
 * The install command for a worktree's lockfile, or null when there is nothing
 * to install (no lockfile, or dependencies are already in place). Only
 * lockfile-driven installs, so the worktree gets exactly what the repo pins.
 */
export function installCommandFor(path: string): { cmd: string; args: string[] } | null {
  if (!existsSync(join(path, "package.json")) || existsSync(join(path, "node_modules"))) return null;
  if (existsSync(join(path, "package-lock.json"))) return { cmd: "npm", args: ["ci", "--no-audit", "--no-fund"] };
  if (existsSync(join(path, "pnpm-lock.yaml"))) return { cmd: "pnpm", args: ["install", "--frozen-lockfile"] };
  if (existsSync(join(path, "yarn.lock"))) return { cmd: "yarn", args: ["install", "--frozen-lockfile"] };
  return null;
}

/**
 * Install dependencies in a fresh worktree so agents can build and test without
 * needing permission to install. Returns a short description of what ran, or
 * null if nothing needed installing. Throws if the install fails.
 */
export async function installDependencies(path: string, signal?: AbortSignal): Promise<string | null> {
  const install = installCommandFor(path);
  if (!install) return null;
  await run(install.cmd, install.args, { cwd: path, signal, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  return [install.cmd, ...install.args].join(" ");
}

/** Commit anything the agent left uncommitted, then list what changed on the branch. */
export async function finalizeWorktree(repo: Repo, mission: Mission, path: string): Promise<string[]> {
  const dirty = await git(path, "status", "--porcelain");
  if (dirty) {
    await git(path, "add", "-A");
    await git(
      path,
      "-c",
      "user.name=Crane",
      "-c",
      "user.email=crane@localhost",
      "commit",
      "-m",
      `crane: ${mission.title}\n\nMission ${mission.id}`,
    );
  }
  let base = repo.defaultBranch;
  try {
    await git(path, "rev-parse", "--verify", base);
  } catch {
    return [];
  }
  const out = await git(path, "diff", "--name-only", `${base}...HEAD`);
  return out ? out.split("\n") : [];
}

export async function diffForMission(repo: Repo, mission: Mission): Promise<string> {
  if (!mission.branch) return "";
  try {
    return await git(repo.path, "diff", `${repo.defaultBranch}...${mission.branch}`);
  } catch {
    return "";
  }
}

export async function removeWorktree(repo: Repo, path: string, opts: { deleteBranch?: string } = {}) {
  try {
    await git(repo.path, "worktree", "remove", "--force", path);
  } catch {
    // already gone
  }
  if (opts.deleteBranch) {
    try {
      await git(repo.path, "branch", "-D", opts.deleteBranch);
    } catch {
      // already gone
    }
  }
}
