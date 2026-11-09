import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ReviewCheckpoint } from "@crane/contracts";
import { preparedDependencyIdentity } from "@crane/worktree-deps";
import { git } from "@crane/backend-runtime";

export type ReviewInputs = Omit<ReviewCheckpoint, "passed">;

/** Set per shell or per directory, so they differ with no change to what checks see of the system. */
const VOLATILE_ENV = new Set(["_", "OLDPWD", "PWD", "SHLVL"]);
const TOOLCHAIN = ["node", "npm", "pnpm", "yarn"];

/** Where a tool resolves on PATH and which build is there, without running anything. */
function toolIdentity(tool: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const file = realpathSync(join(dir, tool));
      const { size, mtimeMs } = statSync(file);
      return `${file}:${size}:${mtimeMs}`;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/**
 * Checks inherit the factory's whole environment, so all of it counts, hashed
 * so that no value is stored. A restart from a different shell may rerun checks
 * it didn't need to, which is the safe direction.
 */
function environmentIdentity(): string {
  const env = Object.entries(process.env).filter(([name]) => !VOLATILE_ENV.has(name)).sort(([a], [b]) => (a < b ? -1 : 1));
  const identity = [process.version, process.platform, process.arch, TOOLCHAIN.map(toolIdentity), env];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** Everything a check result depends on, for the candidate at `cwd`'s HEAD. */
export async function reviewInputs(cwd: string, checks: string[]): Promise<ReviewInputs> {
  return {
    commit: await git(cwd, "rev-parse", "HEAD"),
    tree: await git(cwd, "rev-parse", "HEAD^{tree}"),
    checks,
    dependencies: await preparedDependencyIdentity(cwd),
    environment: environmentIdentity(),
  };
}

/**
 * Whether the worktree and branch still hold exactly what was checkpointed.
 * Untracked files count: finalizing would have committed them, so the agent's
 * work isn't what was checkpointed any more. Unreadable means no.
 */
export async function candidateUnchanged(cwd: string, branch: string, checkpoint: ReviewCheckpoint): Promise<boolean> {
  try {
    return await git(cwd, "rev-parse", "HEAD") === checkpoint.commit
      && await git(cwd, "rev-parse", `refs/heads/${branch}`) === checkpoint.commit
      && await git(cwd, "rev-parse", "HEAD^{tree}") === checkpoint.tree
      && !await git(cwd, "status", "--porcelain");
  } catch {
    return false;
  }
}

/** Why earlier results can't be reused, or an empty list when they can. */
export function changedInputs(checkpoint: ReviewCheckpoint, current: ReviewInputs): string[] {
  const changed: string[] = [];
  if (checkpoint.commit !== current.commit || checkpoint.tree !== current.tree) changed.push("the candidate");
  if (JSON.stringify(checkpoint.checks) !== JSON.stringify(current.checks)) changed.push("the configured checks");
  if (current.dependencies === null || checkpoint.dependencies !== current.dependencies) changed.push("the installed dependencies");
  if (checkpoint.environment !== current.environment) changed.push("the environment");
  return changed;
}
