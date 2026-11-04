import { DRIVER_NAMES, driverLabel, errorMessage, settingsLabel } from "@crane/contracts";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";

export function registerChangeAgent(program: Command, { actions }: CliContext): void {
  program
    .command("change-agent")
    .description("Change the agent, model or effort of a queued task; what you leave out stays, except a new agent clears the old model and effort")
    .argument("<id>")
    .option("--agent <agent>", `run it on: ${DRIVER_NAMES.join(" | ")} | default`)
    .option("--model <model>", "model for this task, or default")
    .option("--effort <level>", "model effort for this task, or default")
    .action((id: string, opts: { agent?: string; model?: string; effort?: string }) => {
      try {
        const m = actions.changeAgent(id, { driver: opts.agent, model: opts.model, effort: opts.effort });
        const settings = settingsLabel(m);
        ui.ok(`${m.driver ? driverLabel(m.driver) : "The default agent"}${settings ? ` (${settings})` : ""} runs it when a crew member picks it up  ${ui.dim(m.id)}`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
}
