import type { CommandAccess } from "@crane/contracts";

/** What each choice means in the Commands sheet, one line under its label. */
export const ACCESS_CHOICE_HINT: Record<CommandAccess, string> = {
  listed: "What Crane allows, plus what you've allowed.",
  most: "Crane's guard blocks risky ones.",
  auto: "Claude Code's auto mode also reviews each command Crane's guard lets through.",
};

/** The short chip a repo row shows. The default shows nothing. */
export function accessChip(commands: CommandAccess): string | null {
  if (commands === "most") return "Most commands";
  if (commands === "auto") return "Auto mode";
  return null;
}

/**
 * What Crane's guard always blocks, by guard category (`GUARD_REASONS` in
 * `packages/agent-policy/src/guard-rules.ts`). These can't be allowed.
 */
export const GUARD_ALWAYS_BLOCKS: Record<string, string> = {
  "shared-git": "Pushing, merging and changing shared Git state",
  "outside-worktree": "Writing outside the task's worktree",
  "operator-actions": "Operator actions, such as crane approve",
  "agent-config": "Changing agent settings or hooks",
  privilege: "Privilege escalation, such as sudo",
  system: "Changing system services, devices or processes",
  credentials: "Reading or sending host credentials",
  "remote-code": "Running downloaded or concealed code",
  "deny-list": "Anything on Crane's permanent deny list",
};

/** Outward-facing commands the guard blocks until the operator allows them for the repo. */
export const GUARD_ASKS_FIRST: Record<string, string> = {
  publish: "Publishing and deploying",
  "global-install": "Installing software outside the project",
  "remote-shell": "Remote connections, such as ssh",
};

export const AUTO_MODE_NOTE =
  "Auto mode uses more tokens and adds a short wait per command. It needs a supported model, and runs fall back to only allowed commands when it's unavailable.";

export const UNAFFECTED_NOTE =
  "Codex always runs in its sandbox, and investigate-only runs stay read-only, whatever this is set to.";
