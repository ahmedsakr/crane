import { errorMessage } from "@crane/contracts";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { act } from "./shared.js";

/** What a queued task waits for: its start time and its prerequisites. */
export function registerSchedule(program: Command, { actions }: CliContext): void {
  program
    .command("schedule")
    .description("Change a queued task's start time; use now to clear it (prerequisites still apply)")
    .argument("<id>")
    .argument("<timestamp>", "ISO timestamp with timezone, or now")
    .action((id: string, timestamp: string) => {
      try {
        const task = actions.schedule(id, timestamp === "now" ? null : timestamp);
        ui.ok(task.scheduledAt ? `Scheduled for ${new Date(task.scheduledAt).toLocaleString()}  ${ui.dim(task.id)}` : `Start time cleared. Prerequisites still apply  ${ui.dim(task.id)}`);
      } catch (err) { ui.fail(errorMessage(err)); }
    });
  act(
    program,
    "waive",
    "Waive a queued task's prerequisites that haven't landed, approving a reduced scope so it starts without them",
    (id, n) => actions.waivePrerequisites(id, n),
    "Waived prerequisites. Its start time still applies",
  );
}
