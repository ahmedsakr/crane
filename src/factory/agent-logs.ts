import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { RunContext } from "@crane/agent-protocol";
import { worktreesDir } from "../core/paths.js";

/** Prepare scratch logs before each attempt, without writing in the operator's checkout. */
export async function prepareAgentLogs(ctx: Pick<RunContext, "cwd" | "repo" | "task" | "job">): Promise<string | undefined> {
  if (!ctx.repo || (ctx.task.autonomy === "observe" && !ctx.job)) return undefined;
  const cwd = await realpath(ctx.cwd);
  const root = await realpath(worktreesDir());
  const rel = relative(root, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || cwd === await realpath(ctx.repo.path)) {
    throw new Error("Crane can only prepare agent logs inside an isolated worktree");
  }
  // A fresh directory cannot contain repository files or symlinks from an earlier agent.
  const directory = await mkdtemp(join(cwd, ".crane-logs-"));
  // Ignore the rule file itself as well as logs, even in repos without a Crane ignore rule.
  await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx" });
  return directory;
}
