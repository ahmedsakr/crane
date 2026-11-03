import { errorMessage } from "@crane/contracts";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";

export function registerRetention(program: Command, { actions }: CliContext): void {
  program
    .command("retention")
    .description("Show or choose how long to keep routine history for finished tasks")
    .option("--days <n>", "irreversibly trim tool events and routine narration after this many finished days")
    .option("--disable", "keep all history and disable attachment cleanup")
    .action((opts: { days?: string; disable?: boolean }) => {
      try {
        if (opts.disable && opts.days !== undefined) throw new Error("Choose --days or --disable");
        if (opts.days !== undefined && !/^\d+$/.test(opts.days)) throw new Error("--days takes a whole number from 1 to 36500");
        const settings = opts.disable || opts.days !== undefined
          ? actions.configureRetention({ finishedTaskDays: opts.disable ? null : Number(opts.days) })
          : actions.retentionSettings();
        console.log(settings.finishedTaskDays === null ? "  Storage retention: disabled; keep all history"
          : `  Storage retention: ${settings.finishedTaskDays} days after tasks finish`);
        console.log("  Enabled cleanup permanently deletes tool events, marked routine narration, and unreferenced screenshots older than a day.");
        console.log("  Status, operator, blocked, error, finding, merge records, tasks and runs stay. Unclassified notes stay.");
        console.log("  The running factory sweeps hourly. The first enabled sweep may rewrite the database once with VACUUM; back up first.");
      } catch (err) { ui.fail(errorMessage(err)); }
    });
}
