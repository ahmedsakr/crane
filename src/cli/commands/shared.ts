import { LOOKOUTS, driverLabel, errorMessage, type BlockedTool, type Lookout } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Store } from "@crane/storage";
import { checkLookouts } from "@crane/factory/actions";
import { factoryDriverName, factoryIsRunning } from "@crane/factory/state";
import * as ui from "../ui.js";

export const repoName = (store: Store, id: string | null) => (id ? store.getRepo(id)?.name : undefined);

/** For options given more than once: `--after t-1 --after t-2`. */
export const collect = (value: string, previous: string[]) => [...previous, value];
export const AFTER_HELP = "wait for this task to land first; repeat for more";
export const ACCEPT_HELP = "an observable condition the work must meet; repeat for more";
export const ACCEPT_CHECK_HELP = "a configured repo check that must pass, by exact command; only Crane's own result counts; repeat for more";
export const LOOK_FOR_HELP = `what else the agent should look out for and report: ${LOOKOUTS.join(" | ")}; repeat or separate with commas`;
/** `--look-for refactoring,test_gaps --look-for improvements`, checked. Fails the command on an unknown name. */
export const lookFor = (given: string[]): Lookout[] => {
  try {
    return checkLookouts(given.flatMap((g) => g.split(",")));
  } catch (err) {
    return ui.fail(errorMessage(err));
  }
};

export function factoryLine(store: Store): string {
  const running = factoryIsRunning(store);
  const paused = store.isPaused();
  if (!running) return `${pc.dim("○")} Factory is off  ${ui.dim("start it with")} crane serve`;
  if (paused) return `${ui.accent("◉")} Factory is paused  ${ui.dim("agents will finish current work, then wait")}`;
  return `${pc.green("◉")} Factory is running  ${ui.dim(`on ${driverLabel(factoryDriverName(store))}`)}`;
}

export function allowCommand(b: BlockedTool, taskId?: string): string {
  const what = b.rule.startsWith("Bash(") ? b.label : b.rule;
  return `crane allow ${JSON.stringify(what)} -r ${b.repoName}${taskId ? ` -t ${taskId}` : ""}`;
}

export const crewMember = (store: Store, member: string) => {
  const a = store.listAgents().find((a) => a.id === member || a.name.toLowerCase() === member.toLowerCase());
  if (!a) throw new Error(`No crew member ${member}`);
  return a;
};

/** "It starts once t-1, t-2 land": what a new task waits for before it can start. */
export function startsOnce(waiting: string[]): string {
  return `It starts once ${waiting.join(", ")} land${waiting.length === 1 ? "s" : ""}`;
}

/** Who runs post-mortems, in the words the Crew page uses. */
export function postmortemCrewLabel(store: Store, crew: string[]): string {
  const named = store.listAgents().filter((a) => crew.includes(a.id));
  return named.length ? named.map((a) => `${a.name}${a.active ? "" : " (on-call)"}`).join(", ") : "any active member";
}

/** A command whose whole job is one action on a task, with an optional note. */
export const act = (program: Command, name: string, desc: string, fn: (id: string, note?: string) => Promise<unknown> | unknown, done: string) =>
  program
    .command(name)
    .description(desc)
    .argument("<id>")
    .option("-m, --message <note>", "leave a note on the task")
    .action(async (id: string, opts: { message?: string }) => {
      try {
        await fn(id, opts.message);
        ui.ok(`${done} ${ui.dim(id)}`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
