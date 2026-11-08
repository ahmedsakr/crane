import { COMMAND_ACCESS, COMMAND_ACCESS_DETAIL, COMMAND_ACCESS_LABEL, errorMessage, type CommandAccess } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";

/** What each other setting would do, as the next step to offer. */
const NEXT: Record<CommandAccess, string> = {
  listed: "only let agents run the commands you allowed",
  most: "let agents run most commands, with Crane's command guard",
  auto: "add Claude Code's auto mode behind Crane's guard",
};

/** `crane commands [listed|most|auto] -r <repo>`: show or choose which commands Claude Code agents may run in a repo. */
export function registerCommandAccess(program: Command, { store, actions }: CliContext): void {
  program
    .command("commands")
    .description("Show or choose which commands Claude Code agents may run in a repo")
    .argument("[access]", COMMAND_ACCESS.join(", "))
    .requiredOption("-r, --repo <repo>", "repo name or id")
    .option("-t, --task <id>", "note it on this task")
    .action((access: string | undefined, opts: { repo: string; task?: string }) => {
      const r = store.getRepo(opts.repo) ?? ui.fail(`No repo called ${opts.repo}. See \`crane repos\`.`);
      let commands = store.repoTools(r.id).commands;
      if (access !== undefined) {
        try {
          commands = actions.setCommandAccess(r.id, access, opts.task).commands;
        } catch (err) {
          ui.fail(errorMessage(err));
        }
        ui.ok(`Set commands for ${pc.bold(r.name)} to ${pc.bold(COMMAND_ACCESS_LABEL[commands])}  ${ui.dim("from each agent's next run")}`);
      } else {
        console.log(`\n  ${pc.bold(r.name)}  ${COMMAND_ACCESS_LABEL[commands]}`);
      }
      console.log(`  ${ui.dim(COMMAND_ACCESS_DETAIL[commands])}`);
      console.log(`  ${ui.dim("Codex always runs in its sandbox, whatever this is set to.")}`);
      const others = COMMAND_ACCESS.filter((c) => c !== commands);
      console.log(`\n${ui.hint(...others.map((c): [string, string] => [`crane commands ${c} -r ${r.name}`, NEXT[c]]))}\n`);
    });
}
