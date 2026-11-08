/** Connected repositories and their operator-owned tool rules. */

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  /** True for the repo Crane itself lives in, used for factory_feature tasks. */
  isFactory: boolean;
  addedAt: string;
}

/**
 * Which commands Claude Code agents in a repo may run. Codex ignores it: it
 * always runs in its sandbox.
 * - `listed`: Crane's defaults plus the commands the operator allowed. The default.
 * - `most`: most commands, with Crane's command guard blocking dangerous ones.
 * - `auto`: most commands, with Crane's guard first and Claude Code's auto mode reviewing the rest.
 */
export type CommandAccess = "listed" | "most" | "auto";

/** Every command access setting, from the narrowest. */
export const COMMAND_ACCESS: readonly CommandAccess[] = ["listed", "most", "auto"];

export const COMMAND_ACCESS_LABEL: Record<CommandAccess, string> = {
  listed: "Only allowed commands",
  most: "Most commands",
  auto: "Most commands, with auto mode",
};

/** One line on what each setting lets agents do. */
export const COMMAND_ACCESS_DETAIL: Record<CommandAccess, string> = {
  listed: "Agents run Crane's default commands and the ones you allowed for this repo.",
  most: "Agents run most commands. Crane's command guard blocks dangerous ones.",
  auto: "Agents run most commands. Crane's command guard checks each one first, then Claude Code's auto mode reviews the rest.",
};

export function isCommandAccess(value: unknown): value is CommandAccess {
  return typeof value === "string" && (COMMAND_ACCESS as readonly string[]).includes(value);
}

/** Tool rules the operator has decided on for one repo. */
export interface RepoTools {
  /** Allowed for every agent working in this repo, on top of Crane's defaults. */
  allowed: string[];
  /** Blocked rules the operator chose to keep blocked, so Crane stops asking. */
  keptBlocked: string[];
  /** Which commands Claude Code agents may run here. Repos saved before this setting read as `listed`. */
  commands: CommandAccess;
}
