import { ACTIVE_STATUSES } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";

export function registerWatch(program: Command, { store }: CliContext): void {
  program
    .command("watch")
    .description("Follow a task, or the whole factory, live")
    .argument("[id]", "task id; omit to watch everything")
    .action(async (id?: string) => {
      const m = id ? store.getTask(id) ?? ui.fail(`No task ${id}`) : null;
      console.log(`\n${ui.brand()}  ${m ? pc.bold(m.title) : "Watching the factory"}  ${ui.dim("ctrl-c to stop")}\n`);
      let cursor = 0;
      if (m) {
        for (const e of store.listEvents(m.id)) {
          console.log(ui.eventLine(e));
          cursor = e.id;
        }
      } else {
        cursor = store.latestEventId();
      }
      const titles = new Map<string, string>();
      for (;;) {
        const events = m ? store.listEvents(m.id, cursor) : store.eventsSince(cursor);
        for (const e of events) {
          if (!m) {
            if (!titles.has(e.taskId)) titles.set(e.taskId, store.getTask(e.taskId)?.title ?? e.taskId);
            console.log(`${ui.dim(ui.truncate(titles.get(e.taskId)!, 22).padEnd(22))} ${ui.eventLine(e)}`);
          } else console.log(ui.eventLine(e));
          cursor = e.id;
        }
        if (m) {
          const now = store.getTask(m.id)!;
          if (!ACTIVE_STATUSES.includes(now.status)) {
            console.log(`\n${ui.statusDot(now.status)} ${ui.statusText(now.status)}  ${ui.dim(`crane show ${m.id}`)}\n`);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    });
}
