import { Command } from "commander";
import { hostActor, withActor } from "../core/actor.js";
import type { Store } from "../core/store.js";
import { registerAgents } from "./commands/agents.js";
import { registerAnalytics } from "./commands/analytics.js";
import { registerChangeAgent } from "./commands/change-agent.js";
import { registerDecisions } from "./commands/decisions.js";
import { registerDiff } from "./commands/diff.js";
import { registerDo } from "./commands/do.js";
import { registerFactoryControl } from "./commands/factory-control.js";
import { registerFollowUps } from "./commands/follow-ups.js";
import { registerGoals } from "./commands/goals.js";
import { registerHome } from "./commands/home.js";
import { registerPermissions } from "./commands/permissions.js";
import { registerQueue } from "./commands/queue.js";
import { registerRepos } from "./commands/repos.js";
import { registerRetention } from "./commands/retention.js";
import { registerSchedule } from "./commands/schedule.js";
import { registerServe } from "./commands/serve.js";
import { registerShow } from "./commands/show.js";
import { registerTasks } from "./commands/tasks.js";
import { registerWatch } from "./commands/watch.js";
import { createCliContext, type CliContext } from "./context.js";
import { setupCommand } from "./setup.js";

/** A fresh `crane` command tree. Help lists commands in the order they register here. */
export function buildProgram(ctx: CliContext): Command {
  const program = new Command()
    .name("crane")
    .description("An autonomous software factory you steer.")
    .showSuggestionAfterError()
    .configureHelp({ sortSubcommands: false });

  program.addCommand(setupCommand());
  registerHome(program, ctx);
  registerGoals(program, ctx);
  registerDo(program, ctx);
  registerTasks(program, ctx);
  registerQueue(program, ctx);
  registerShow(program, ctx);
  registerWatch(program, ctx);
  registerDecisions(program, ctx);
  registerChangeAgent(program, ctx);
  registerSchedule(program, ctx);
  registerFollowUps(program, ctx);
  registerDiff(program, ctx);
  registerRepos(program, ctx);
  registerPermissions(program, ctx);
  registerAgents(program, ctx);
  registerRetention(program, ctx);
  registerAnalytics(program, ctx);
  registerFactoryControl(program, ctx);
  registerServe(program, ctx);
  return program;
}

/** Runs one CLI command against `target`. `argv` is shaped like `process.argv`: node, script, then arguments. */
export async function runCli(argv: string[], target: Store): Promise<void> {
  const ctx = createCliContext(target);
  await ctx.actions.ensureFactoryRepo();
  const run = () => buildProgram(ctx).parseAsync(argv);
  // Commands run as the host, so their decisions say so. The factory itself
  // doesn't: its schedules and every request it serves would inherit the host.
  await (FACTORY_COMMANDS.has(argv[2] ?? "") ? run() : withActor(hostActor(), run));
}

const FACTORY_COMMANDS = new Set(["serve", "start"]);
