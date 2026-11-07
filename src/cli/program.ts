import { Command } from "commander";
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
import { withActor } from "../core/actor.js";
import { registerAuth } from "./commands/auth.js";
import { registerOperators } from "./commands/operators.js";
import { createCliContext, type CliContext, type CliIo } from "./context.js";
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
  registerOperators(program, ctx);
  registerAuth(program, ctx);
  return program;
}

/**
 * Runs one CLI command against `target`. `argv` is shaped like `process.argv`:
 * node, script, then arguments. The command runs as the host, so what it
 * records is attributed to whoever ran crane on this machine.
 */
export async function runCli(argv: string[], target: Store, io: Partial<CliIo> = {}): Promise<void> {
  const ctx = createCliContext(target, io);
  await withActor(ctx.host, async () => {
    await ctx.actions.ensureFactoryRepo();
    await buildProgram(ctx).parseAsync(argv);
  });
}
