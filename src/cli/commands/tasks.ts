import type { TaskStatus } from "@crane/contracts";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { repoName } from "./shared.js";

interface TasksOptions {
  all?: boolean; status?: string; repo?: string; limit: string; json?: boolean;
}

export function registerTasks(program: Command, ctx: CliContext): void {
  program
    .command("tasks")
    // `missions` is the old name, kept so muscle memory still works.
    .aliases(["ls", "missions"])
    .description("List tasks (open ones by default)")
    .option("-a, --all", "include finished tasks")
    .option("-s, --status <statuses>", "comma-separated, e.g. needs_review,failed")
    .option("-r, --repo <repo>", "only this repo")
    .option("-n, --limit <n>", "how many to list, newest first", "50")
    .option("--json", "print the tasks as JSON, with each one's branch and worktree")
    .action((opts: TasksOptions) => listTasks(ctx, opts));
}

function listTasks({ store }: CliContext, opts: TasksOptions): void {
  const status = opts.status
    ? (opts.status.split(",") as TaskStatus[])
    : opts.all
      ? undefined
      : (["needs_review", "merging", "running", "queued"] as TaskStatus[]);
  const repoId = opts.repo ? (store.getRepo(opts.repo) ?? ui.fail(`No repo called ${opts.repo}. See \`crane repos\`.`)).id : undefined;
  const limit = Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) ui.fail(`--limit takes a whole number above 0, not ${opts.limit}`);
  const list = store.listTasks({ status, repoId, limit });
  if (opts.json) {
    console.log(JSON.stringify(list.map((m) => ({ ...m, repo: repoName(store, m.repoId) ?? null })), null, 2));
    return;
  }
  if (!list.length) {
    console.log(`\n  ${ui.dim(opts.all ? "No tasks yet." : "No open tasks.")}  ${ui.dim("Start one with")} crane do "…"\n`);
    return;
  }
  const groups = new Map<TaskStatus, typeof list>();
  for (const m of list) groups.set(m.status, [...(groups.get(m.status) ?? []), m]);
  const order: TaskStatus[] = [
    "needs_review",
    "merging",
    "running",
    "queued",
    "failed",
    "merged",
    "done",
    "approved",
    "rejected",
    "cancelled",
  ];
  for (const s of order) {
    const g = groups.get(s);
    if (!g) continue;
    console.log(ui.section(ui.statusText(s), g.length));
    for (const m of g) console.log(ui.taskLine(m, repoName(store, m.repoId)));
  }
  console.log("");
}
