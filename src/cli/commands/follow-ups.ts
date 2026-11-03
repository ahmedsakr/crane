import { DRIVER_NAMES, UNSHIPPED_STATUSES, driverLabel, errorMessage, prerequisiteMet } from "@crane/contracts";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { ACCEPT_HELP, AFTER_HELP, LOOK_FOR_HELP, collect, lookFor } from "./shared.js";

/** New runs from an existing task: `retry` and `follow-up`. */
export function registerFollowUps(program: Command, ctx: CliContext): void {
  registerRetry(program, ctx);
  registerFollowUp(program, ctx);
}

function registerRetry(program: Command, { actions }: CliContext): void {
  program
    .command("retry")
    .description("Run a task again from scratch")
    .argument("<id>")
    .option("--agent <agent>", `run it on another agent: ${DRIVER_NAMES.join(" | ")} | default`)
    .action((id: string, opts: { agent?: string }) => {
      try {
        const m = actions.retry(id, { driver: opts.agent });
        ui.ok(`Queued again as ${m.id}${m.driver ? ` on ${driverLabel(m.driver)}` : ""}`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
}

function registerFollowUp(program: Command, { store, actions }: CliContext): void {
  program
    .command("follow-up")
    .description("Turn a finding into a task that makes the change")
    .argument("<id>")
    .argument("<finding>", "finding number, as shown in crane show")
    .option("--agent <agent>", `run it on an agent: ${DRIVER_NAMES.join(" | ")} | default`)
    .option("--model <model>", "model for this follow-up only; requires a chosen agent")
    .option("--effort <level>", "model effort for this follow-up only; requires a chosen agent")
    .option("--after <id>", AFTER_HELP, collect, [])
    .option("--accept <criterion>", ACCEPT_HELP, collect, [])
    .option("--look-for <what>", LOOK_FOR_HELP, collect, [])
    .action((id: string, n: string, opts: {
      agent?: string; model?: string; effort?: string; after: string[]; accept: string[]; lookFor: string[];
    }) => {
      try {
        const m = actions.followUp(id, Number(n) - 1, {
          driver: opts.agent, model: opts.model, effort: opts.effort, prerequisites: opts.after, acceptance: opts.accept,
          lookouts: lookFor(opts.lookFor),
        });
        const waiting = store.unmetPrerequisites(m).map((t) => t.id);
        ui.ok(`${waiting.length ? `Queued ${m.id}. It starts once ${waiting.join(", ")} land${waiting.length === 1 ? "s" : ""}` : `Started ${m.id}`}  ${ui.dim(m.title)}`);
        // The web form waits for an unlanded parent by default; here it's a hint, so scripts keep their behaviour.
        const parent = store.getTask(id);
        if (parent?.branch && !prerequisiteMet(parent) && !UNSHIPPED_STATUSES.includes(parent.status) && !m.prerequisites.includes(parent.id)) {
          console.log(ui.dim(`  It starts from the default branch, without ${parent.id}'s unmerged changes. To wait for them, cancel it and add --after ${parent.id}.`));
        }
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
}
