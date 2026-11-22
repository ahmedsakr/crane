import { DEFAULT_PORT } from "@crane/backend-runtime";
import { runnerLabel, type EventActor } from "@crane/contracts";
import type { IssuedRunner } from "@crane/factory/actions";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { attempt } from "./access-shared.js";
import { AS_OPERATOR_HELP, cliActor } from "./operator-identity.js";

export function registerRunners(program: Command, ctx: CliContext): void {
  const runners = program.command("runners").description("Manage containers that run tasks on operators' compute")
    .option("--as-operator <username>", AS_OPERATOR_HELP);
  const act = (fn: (by: EventActor) => void) => attempt(async () => {
    fn(await cliActor(ctx, runners.opts<{ asOperator?: string }>().asOperator));
  });
  const { actions } = ctx;

  runners.command("add <name>").description("Register a container and print its token")
    .option("--operator <username>", "assign the container to this operator (host only, required on the host)")
    .option("--capacity <n>", "how many jobs it can run at once (default: 1)")
    .action((name: string, opts: { operator?: string; capacity?: string }) => act((by) => {
      const capacity = opts.capacity === undefined ? undefined : Number(opts.capacity);
      printIssued(ctx, "Added", actions.addRunner(by, { name, operator: opts.operator, capacity }));
    }));

  runners.command("list").description("List registered containers")
    .option("--json", "print container summaries as JSON")
    .action((opts: { json?: boolean }) => act((by) => {
      const list = actions.listRunners(by);
      if (opts.json) return console.log(JSON.stringify(list, null, 2));
      console.log(ui.section("Containers", list.length));
      for (const runner of list) {
        console.log(`  ${runner.id}  ${runnerLabel(runner)}  ${runner.online ? "online" : "offline"}  ${runner.busy}/${runner.capacity} jobs`);
      }
    }));

  runners.command("rename <id> <name>").description("Rename a container")
    .action((id: string, name: string) => act((by) => {
      ui.ok(`Renamed ${runnerLabel(actions.renameRunner(by, id, name))}  ${ui.dim(id)}`);
    }));
  runners.command("capacity <id> <n>").description("Set how many jobs a container can run at once")
    .action((id: string, value: string) => act((by) => {
      const runner = actions.setRunnerCapacity(by, id, Number(value));
      ui.ok(`Set capacity to ${runner.capacity} for ${runnerLabel(runner)}  ${ui.dim(id)}`);
    }));
  runners.command("rotate <id>").description("Replace a container's token and print the new one")
    .action((id: string) => act((by) => printIssued(ctx, "Rotated token for", actions.rotateRunnerToken(by, id))));
  runners.command("remove <id>").description("Remove a container and revoke its token")
    .action((id: string) => act((by) => {
      actions.removeRunner(by, id);
      ui.ok(`Removed container ${id}`);
    }));
  runners.command("required [on|off]").description("Show or change whether operators must use containers")
    .action((value: string | undefined) => act((by) => {
      console.log(value === undefined ? actions.runnersRequired() : actions.setRunnersRequired(by, value));
    }));
}

function printIssued({ store }: CliContext, verb: string, { runner, token }: IssuedRunner): void {
  const origin = store.publicUrl();
  const url = origin ?? `http://localhost:${DEFAULT_PORT}`;
  const quotedUrl = `'${url.replaceAll("'", "'\\''")}'`;
  ui.ok(`${verb} ${runnerLabel(runner)}  ${ui.dim(runner.id)}`);
  console.log("  Copy the command now. Crane shows this token once.");
  if (!origin) console.log("  For a container on another machine, replace localhost with Crane's reachable address.");
  console.log(`  printf '%s\\n' '${token}' | crane runner start --url ${quotedUrl} --token-stdin`);
}
