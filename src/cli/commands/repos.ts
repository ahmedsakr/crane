import { errorMessage, ruleLabel } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { collect } from "./shared.js";

interface ChecksOptions {
  set: string[];
  clear?: boolean;
  json?: boolean;
}

export function registerRepos(program: Command, ctx: CliContext): void {
  const { store, actions } = ctx;
  const repos = program.command("repos").description("The codebases the factory works on");
  repos.action(() => listRepos(ctx));
  repos
    .command("add")
    .description("Connect a git repository")
    .argument("<path>")
    .option("-n, --name <name>", "what to call it")
    .action(async (path: string, opts: { name?: string }) => {
      try {
        const r = await actions.connectRepo(path, opts.name);
        ui.ok(`Connected ${pc.bold(r.name)}  ${ui.dim(`${r.path} · ${r.defaultBranch}`)}`);
        console.log(ui.hint(
          [`crane repos checks ${r.name} --set "npm test"`, "set what its work must pass"],
          [`crane do "investigate open maintenance work in ${r.name}"`, "a good first task"],
        ));
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
  repos
    .command("checks")
    .description("Show or replace the commands a repo's work must pass before review and merge")
    .argument("<repo>")
    .option("--set <command>", "replace the checks; repeat for each command", collect, [])
    .option("--clear", "remove every check, so work in this repo can't pass review or merge")
    .option("--json", "print the checks as JSON")
    .action((name: string, opts: ChecksOptions) => repoChecks(ctx, name, opts));
  repos
    .command("remove")
    .alias("rm")
    .description("Disconnect a repo (its tasks are kept)")
    .argument("<repo>")
    .action((name: string) => {
      const r = store.getRepo(name) ?? ui.fail(`No repo ${name}`);
      if (r.isFactory) ui.fail("The factory's own repo can't be removed.");
      store.removeRepo(r.id);
      ui.ok(`Disconnected ${r.name}`);
    });
}

function listRepos({ store }: CliContext): void {
  const list = store.listRepos();
  console.log(ui.section("Repos", list.length));
  for (const r of list) {
    const open = store.listTasks({ repoId: r.id, status: ["queued", "running", "needs_review", "merging"] }).length;
    console.log(
      `  ${r.isFactory ? ui.accent("▟") : pc.dim("■")} ${pc.bold(r.name.padEnd(24))} ${ui.dim(r.path)}${
        open ? `  ${open} open` : ""
      }`,
    );
    const allowed = store.repoTools(r.id).allowed;
    if (allowed.length) console.log(`    ${ui.dim("also allowed:")} ${allowed.map(ruleLabel).join(", ")}`);
  }
  const withAllowed = list.find((r) => store.repoTools(r.id).allowed.length);
  const next: [string, string][] = [["crane repos add <path>", "connect another codebase"]];
  if (withAllowed) {
    const first = ruleLabel(store.repoTools(withAllowed.id).allowed[0]!);
    next.push([`crane disallow ${JSON.stringify(first)} -r ${withAllowed.name}`, "stop allowing a command"]);
  }
  console.log(`\n${ui.hint(...next)}\n`);
}

function repoChecks({ store, actions }: CliContext, name: string, opts: ChecksOptions): void {
  const r = store.getRepo(name) ?? ui.fail(`No repo called ${name}. See \`crane repos\`.`);
  if (opts.clear && opts.set.length) ui.fail("Use --set or --clear, not both.");
  const changing = opts.clear || opts.set.length > 0;
  let commands = store.repoChecks(r.id);
  if (changing) {
    try {
      commands = actions.configureChecks(r.id, opts.set);
    } catch (err) {
      ui.fail(errorMessage(err));
    }
  }
  if (opts.json) {
    console.log(JSON.stringify(commands, null, 2));
    return;
  }
  if (changing) ui.ok(`Saved checks for ${pc.bold(r.name)}  ${ui.dim("they apply from the next check")}`);
  console.log(ui.section(`Checks for ${r.name}`, commands.length));
  for (const command of commands) console.log(`  ${command}`);
  if (!commands.length) {
    console.log(`  ${ui.dim("None set. Work in this repo can't pass review or merge until you add one.")}`);
    console.log(`\n${ui.hint([`crane repos checks ${r.name} --set "npm test"`, "add a check"])}`);
  }
  console.log("");
}
