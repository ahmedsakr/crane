import { resolvePath, within } from "./guard-paths.js";
import type { GuardCommand, GuardContext } from "./guard-types.js";

const GIT_PATH_OPTIONS = ["-C", "--git-dir", "--work-tree"];
const JOB_COMMANDS = new Set(["commit", "reset", "checkout", "switch", "rebase", "stash", "cherry-pick", "revert"]);

function gitArguments(part: GuardCommand, ctx: GuardContext): { args: string[]; outside: boolean } {
  let cwd = part.cwd;
  for (let i = 1; i < part.words.length; i++) {
    const word = part.words[i]!;
    const option = GIT_PATH_OPTIONS.find((name) => word === name || word.startsWith(name + "=") || (name === "-C" && word.startsWith("-C")));
    if (option) {
      let target = word.slice(option.length).replace(/^=/, "");
      if (!target) target = part.words[++i] ?? "$UNKNOWN";
      const path = resolvePath(target, cwd, ctx);
      if (!path || !within(path, ctx.worktree)) return { args: [], outside: true };
      if (option === "-C") cwd = path;
    } else if (["-c", "--config-env", "--namespace"].includes(word)) i++;
    else if (word.startsWith("-")) continue;
    else return { args: part.words.slice(i), outside: cwd === null || !within(cwd, ctx.worktree) };
  }
  return { args: [], outside: false };
}

function configWrite(args: string[]): boolean {
  const writes = ["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "--edit", "-e"];
  if (args.some((arg) => writes.includes(arg) || writes.some((flag) => arg.startsWith(flag + "=")))) return true;
  return !args.some((arg) => arg === "-l" || arg === "--list" || /^--get(?:-|$)/.test(arg));
}

function defaultBranch(args: string[], ctx: GuardContext): boolean {
  return args.some((arg) => arg === ctx.defaultBranch || arg === "refs/heads/" + ctx.defaultBranch);
}

export function sharedGit(part: GuardCommand, ctx: GuardContext): boolean {
  const parsed = gitArguments(part, ctx);
  if (parsed.outside) return true;
  const [subcommand, ...args] = parsed.args;
  if (!subcommand) return false;
  if (["push", "merge", "update-ref", "symbolic-ref", "filter-branch", "filter-repo"].includes(subcommand)) return true;
  if (ctx.profile === "job" && JOB_COMMANDS.has(subcommand)) return true;
  if (["checkout", "switch"].includes(subcommand) && defaultBranch(args, ctx)) return true;
  if (subcommand === "config") return configWrite(args);
  if (subcommand === "remote") return args.some((arg) => ["add", "set-url", "remove", "rm", "rename"].includes(arg));
  if (subcommand === "worktree") return args.some((arg) => ["add", "remove", "prune", "move"].includes(arg));
  if (subcommand === "tag") return args.some((arg) => arg === "--delete" || /^-[a-zA-Z]*d/.test(arg));
  return subcommand === "branch" && defaultBranch(args, ctx)
    && args.some((arg) => /^-[a-zA-Z]*[fdDmM]/.test(arg) || ["--force", "--delete", "--move"].includes(arg));
}
