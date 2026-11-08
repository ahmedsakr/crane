import type { GuardContext } from "@crane/agent-policy";

/**
 * Claude Code's built-in rules. A list that omits it replaces them, so every
 * list Crane sends starts with it (docs/command-guard.md, question 14).
 */
export const AUTO_MODE_DEFAULTS = "$defaults";

/**
 * The `autoMode` section of an auto-mode run's inline `--settings`: what
 * Claude Code's classifier should know about Crane. Without it, the built-in
 * rules let an agent push to its repo and approve tasks through the local API
 * (question 14). Crane never adds `allow` entries: a call the guard and the
 * narrow allow rules don't decide is always left to the classifier.
 */
export interface AutoModeSettings {
  environment: string[];
  soft_deny: string[];
  hard_deny: string[];
}

function environment(ctx: GuardContext): string[] {
  const entries = [
    `**Crane task worktree**: The agent works in a Crane-managed git worktree at ${ctx.worktree}, on its own task branch. That worktree is the project scope.`,
  ];
  if (ctx.checkout !== ctx.worktree) {
    entries.push(`**Outside scope**: The operator's own checkout at ${ctx.checkout} and Crane's home at ${ctx.craneHome} are not part of the project. The agent never changes them.`);
  } else {
    entries.push(`**Outside scope**: Crane's home at ${ctx.craneHome} is not part of the project. The agent never changes it.`);
  }
  entries.push(
    `**Trusted repo**: This repository and its configured remotes. Pushing, merging and moving the default branch \`${ctx.defaultBranch}\` happen only through Crane, after the operator approves.`,
    "**Crane control plane**: The local Crane API (any localhost or 127.0.0.1 URL whose path starts with /api/, by default on port 4471) and the Crane CLI's state-changing commands (such as `crane approve`, `crane merge` or `npm run crane -- <command>`) belong to the human operator.",
  );
  return entries;
}

function hardDeny(ctx: GuardContext): string {
  return `Crane Operator Actions: Approving, merging, retrying or configuring tasks, repos or permissions through the Crane CLI or the local Crane API, pushing, or changing the default branch \`${ctx.defaultBranch}\`. These are never part of the agent's task; only the operator does them, through Crane.`;
}

export function autoModeSettings(ctx: GuardContext): AutoModeSettings {
  return {
    environment: [AUTO_MODE_DEFAULTS, ...environment(ctx)],
    soft_deny: [AUTO_MODE_DEFAULTS],
    hard_deny: [AUTO_MODE_DEFAULTS, hardDeny(ctx)],
  };
}
