import { errorMessage, ruleLabel } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Store } from "../../core/store.js";
import { toRule } from "../../factory/actions.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { allowCommand } from "./shared.js";

/** The repo a rule is about: the one named, or the only one where it's been blocked. */
function repoForRule(store: Store, input: string, repo?: string) {
  if (repo) return store.getRepo(repo) ?? ui.fail(`No repo called ${repo}. See \`crane repos\`.`);
  const rule = toRule(input);
  const where = [...new Set(store.blockedTools().filter((b) => b.rule === rule).map((b) => b.repoId))];
  if (where.length === 1) return store.getRepo(where[0]!)!;
  ui.fail(`Which repo? Add --repo <name>.${where.length ? "" : " Agents haven't been blocked from this anywhere yet."}`);
}

/** Blocked commands and per-repo tools. */
export function registerPermissions(program: Command, ctx: CliContext): void {
  registerBlocked(program, ctx);
  registerRuleDecisions(program, ctx);
}

function registerBlocked(program: Command, { store }: CliContext): void {
  program
    .command("blocked")
    .description("Commands agents were blocked from, added up across tasks")
    .option("-r, --repo <repo>", "only this repo")
    .action((opts: { repo?: string }) => {
      const repoId = opts.repo ? (store.getRepo(opts.repo) ?? ui.fail(`No repo ${opts.repo}`)).id : undefined;
      const list = store.blockedTools({ repoId });
      if (!list.length) {
        console.log(`\n  ${ui.dim("Nothing is waiting on you. Agents haven't been blocked from anything you haven't decided on.")}\n`);
        return;
      }
      console.log(ui.section(ui.accent("Blocked commands"), list.length));
      for (const b of list) console.log(ui.blockedLine(b));
      console.log(
        `\n${ui.hint(
          [allowCommand(list[0]!), `let agents run it in ${list[0]!.repoName}`],
          [allowCommand(list[0]!).replace("crane allow", "crane keep-blocked"), "keep it blocked and stop asking"],
        )}\n`,
      );
    });
}

function registerRuleDecisions(program: Command, { store, actions }: CliContext): void {
  program
    .command("allow")
    .description("Let agents in a repo run a command they were blocked from")
    .argument("<command>", 'a command, e.g. "npm ci", or a rule, e.g. "Bash(npm ci:*)"')
    .option("-r, --repo <repo>", "repo name or id")
    .option("-t, --task <id>", "note it on this task")
    .action((input: string, opts: { repo?: string; task?: string }) => {
      try {
        const r = repoForRule(store, input, opts.repo);
        actions.allowTool(r.id, input, opts.task);
        ui.ok(`Allowed ${pc.bold(ruleLabel(toRule(input)))} for ${r.name}  ${ui.dim("agents can run it from their next task")}`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });

  program
    .command("keep-blocked")
    .description("Keep a blocked command blocked, and stop asking about it")
    .argument("<command>")
    .option("-r, --repo <repo>", "repo name or id")
    .option("-t, --task <id>", "note it on this task")
    .action((input: string, opts: { repo?: string; task?: string }) => {
      try {
        const r = repoForRule(store, input, opts.repo);
        actions.keepBlocked(r.id, input, opts.task);
        ui.ok(`Kept ${pc.bold(ruleLabel(toRule(input)))} blocked for ${r.name}`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });

  program
    .command("disallow")
    .description("Stop allowing a command you allowed for a repo")
    .argument("<command>")
    .requiredOption("-r, --repo <repo>", "repo name or id")
    .action((input: string, opts: { repo: string }) => {
      try {
        const r = repoForRule(store, input, opts.repo);
        actions.disallowTool(r.id, input);
        ui.ok(`Stopped allowing ${pc.bold(ruleLabel(toRule(input)))} for ${r.name}`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
}
