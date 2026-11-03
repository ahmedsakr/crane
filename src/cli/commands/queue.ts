import { errorMessage } from "@crane/contracts";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { repoName } from "./shared.js";

export function registerQueue(program: Command, { store, actions }: CliContext): void {
  program
    .command("queue")
    .description("List tasks in pickup order, or move a task before another or to the end")
    .argument("[id]", "queued task to move")
    .option("--before <id>", "move before this queued task")
    .option("--last", "move to the end of the queue")
    .option("--json", "print the queue as JSON")
    .action((id: string | undefined, opts: { before?: string; last?: boolean; json?: boolean }) => {
      try {
        if (id ? !!opts.before === !!opts.last : opts.before !== undefined || opts.last) {
          throw new Error("Use crane queue to list, or crane queue <id> with either --before <id> or --last");
        }
        const queue = id ? actions.moveQueuedTask(id, opts.before ?? null) : store.listQueuedTasks();
        if (opts.json) console.log(JSON.stringify(queue, null, 2));
        else {
          if (id) ui.ok("Queue reordered. Start times, prerequisites and crew assignments still apply.");
          console.log(ui.section("Queue", queue.length));
          queue.forEach((m, i) => console.log(`  ${i + 1}. ${ui.taskLine(m, repoName(store, m.repoId))}`));
          if (!queue.length) console.log("  No tasks queued.");
          console.log("");
        }
      } catch (err) { ui.fail(errorMessage(err)); }
    });
}
