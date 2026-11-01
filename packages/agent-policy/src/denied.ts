/**
 * Crane's deny list, shared by drivers (what an agent may never run) and
 * operator actions (what an operator may never allow). It has no imports.
 */

/**
 * Never allowed, regardless of autonomy. Agents never ship code: when the
 * operator approves a merge, Crane's own code (src/factory/merge.ts) does it.
 */
export const ALWAYS_DENIED = ["Bash(git push:*)", "Bash(git checkout main:*)", "Bash(git merge:*)", "Bash(rm -rf:*)"];
