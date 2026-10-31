/**
 * Crane's agent safety policy, shared by drivers and operator actions. It has
 * no imports so anything can depend on it without pulling in a concrete agent.
 */

/**
 * Never allowed, regardless of autonomy. Agents never ship code: when the
 * operator approves a merge, Crane's own code (src/factory/merge.ts) does it.
 */
export const ALWAYS_DENIED = ["Bash(git push:*)", "Bash(git checkout main:*)", "Bash(git merge:*)", "Bash(rm -rf:*)"];
