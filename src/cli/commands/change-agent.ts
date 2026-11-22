import { DRIVER_NAMES, driverLabel, settingsLabel } from "@crane/contracts";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { attempt } from "./access-shared.js";
import { AS_OPERATOR_HELP, cliActor } from "./operator-identity.js";

interface ChangeAgentOptions {
  agent?: string;
  model?: string;
  effort?: string;
  runner?: string;
  asOperator?: string;
}

export function registerChangeAgent(program: Command, ctx: CliContext): void {
  program
    .command("change-agent")
    .description("Change a queued task's agent, model or effort, or route a task to another container or the crew")
    .argument("<id>")
    .option("--agent <agent>", `run it on: ${DRIVER_NAMES.join(" | ")} | default`)
    .option("--model <model>", "model for this task, or default")
    .option("--effort <level>", "model effort for this task, or default")
    .option("--runner <id|none>", "run on your container, or use none to return to the crew")
    .option("--as-operator <username>", AS_OPERATOR_HELP)
    .action((id: string, opts: ChangeAgentOptions) => attempt(async () => {
      const by = await cliActor(ctx, opts.asOperator);
      const runnerId = opts.runner === "none" ? null : opts.runner;
      const task = ctx.actions.changeAgent(id, { driver: opts.agent, model: opts.model, effort: opts.effort, runnerId }, by);
      const agent = task.driver ? driverLabel(task.driver) : "The default agent";
      const settings = settingsLabel(task);
      const lane = task.runnerId ? `on container ${task.runnerId}` : "when a crew member picks it up";
      ui.ok(`${agent}${settings ? ` (${settings})` : ""} runs it ${lane}  ${ui.dim(task.id)}`);
    }));
}
