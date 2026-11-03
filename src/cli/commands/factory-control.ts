import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";

/** `pause` and `resume`: whether agents pick up new tasks. */
export function registerFactoryControl(program: Command, { actions }: CliContext): void {
  program
    .command("pause")
    .description("Stop picking up new tasks (current work finishes)")
    .action(() => {
      actions.pause();
      ui.ok("Factory paused. Agents will finish what they're doing, then wait.");
    });

  program
    .command("resume")
    .description("Start picking up tasks again")
    .action(() => {
      actions.resume();
      ui.ok("Factory resumed.");
    });
}
