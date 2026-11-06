import type { Repo, Task } from "@crane/contracts";
import type { SiblingTask } from "@crane/agent-protocol";
import { git } from "../core/git.js";
import type { Store } from "../core/store.js";
import { comparisonBase } from "./git.js";

/** Read shared refs, never sibling worktrees: their uncommitted work belongs to their agents. */
export async function siblingTasksFor(store: Store, task: Task, repo: Repo): Promise<SiblingTask[]> {
  const siblings = store.listTasks({
    repoId: repo.id,
    status: ["queued", "running", "needs_review", "approved", "merging", "done"],
    // Filter finished observations before capping the snapshot, so they can't hide pending work.
    limit: -1,
  }).filter((t) => t.id !== task.id && (t.status !== "done" || t.branch)).slice(0, 200);
  if (!siblings.length) return [];
  let branches: Set<string> | null = null;
  let unmerged: Set<string> | null = null;
  try {
    // Two reads for the whole snapshot, rather than a subprocess for each sibling.
    const main = (await comparisonBase(repo)) ?? `refs/heads/${repo.defaultBranch}`;
    const refs = await Promise.all([
      git(repo.path, "for-each-ref", "--format=%(refname)", "refs/heads/"),
      git(repo.path, "for-each-ref", "--format=%(refname)", `--no-merged=${main}`, "refs/heads/"),
    ]);
    branches = new Set(refs[0].split("\n"));
    unmerged = new Set(refs[1].split("\n"));
  } catch {
    // A missing/deleted ref or an unreadable repo is unknown, not evidence of no work.
  }
  return siblings.map(({ id, title, status, branch }) => ({
    id, title, status, branch, hasCommits: branchHasCommits(branch, branches, unmerged),
  }));
}

/** Null when the refs couldn't be read or the branch is missing: unknown, not evidence of no work. */
function branchHasCommits(branch: string | null, branches: Set<string> | null, unmerged: Set<string> | null): boolean | null {
  if (!branch) return false;
  const ref = `refs/heads/${branch}`;
  if (!branches?.has(ref) || !unmerged) return null;
  return unmerged.has(ref);
}
