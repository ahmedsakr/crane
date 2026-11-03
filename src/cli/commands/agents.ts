import {
  AUTONOMY_LABEL,
  DRIVER_NAMES,
  EFFORT_LEVELS,
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  driverLabel,
  errorMessage,
  settingsLabel,
} from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Store } from "../../core/store.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { registerCrewSchedules } from "./crew-schedules.js";
import { crewMember, factoryLine, postmortemCrewLabel } from "./shared.js";

/** `--crew hoist,boom`, or `default` to leave post-mortems to any active member. */
function parsePostmortemCrew(store: Store, value: string): string[] {
  if (value.trim().toLowerCase() === "default") return [];
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new Error("Name at least one crew member, or use default for any active member");
  return names.map((name) => crewMember(store, name).id);
}

/** The crew and which agent they run on. Subcommands register in the order help lists them. */
export function registerAgents(program: Command, ctx: CliContext): void {
  const agents = program
    .command("agents")
    .description("Who's on the crew, and which agent they run on")
    .action(() => showCrew(ctx));
  registerMemberCommands(agents, ctx);
  registerCrewSchedules(agents, ctx);
  registerRoles(agents, ctx);
  registerAgentSettings(agents, ctx);
  registerPostmortem(agents, ctx);
}

async function showCrew({ store, actions }: CliContext): Promise<void> {
  console.log(`\n${factoryLine(store)}`);
  const list = store.listAgents();
  console.log(ui.section("Crew", list.length));
  if (!list.length) console.log(`  ${ui.dim("No agents yet. They clock in when you run")} crane serve`);
  for (const a of list) {
    const title = a.taskId ? store.getTask(a.taskId)?.title : undefined;
    const role = a.role ? ` · role: ${MAINTENANCE_ROLE[a.role].label}` : "";
    const postmortems = a.runsPostmortems ? " · runs post-mortems" : "";
    console.log(`  ${a.active ? "Active" : "On-call"} · default: ${a.defaultDriver ? driverLabel(a.defaultDriver) : "factory default"}${role}${postmortems}`);
    console.log(ui.agentLine(a, title ? `${title}  ${ui.dim(`on ${driverLabel(a.driver)}`)}` : undefined));
  }
  const catalog = await actions.drivers();
  console.log(ui.section("Runs on"));
  for (const d of catalog) {
    const mark = d.isDefault ? ui.accent("●") : d.available ? pc.dim("○") : pc.dim("·");
    const name = d.label.padEnd(12);
    console.log(`  ${mark} ${d.available ? name : pc.dim(name)} ${ui.dim(d.isDefault ? `default · ${d.hint}` : d.hint)}`);
    if (d.efforts.length && d.available) {
      console.log(`    ${" ".repeat(12)} ${settingsLabel(d) ?? ui.dim("its default model and effort")}`);
    }
  }
  const postmortem = actions.postmortemSettings();
  console.log(ui.section("Post-mortems"));
  console.log(`  ${postmortem.driver ? driverLabel(postmortem.driver) : "Merged task's agent"} · ${settingsLabel(postmortem) ?? "agent settings"}`);
  console.log(`  Run by ${postmortemCrewLabel(store, postmortem.crew)}`);
  console.log("");
  const other = catalog.find((d) => d.available && !d.isDefault && d.name !== "simulated");
  const tunable = catalog.find((d) => d.isDefault && d.efforts.length) ?? catalog.find((d) => d.available && d.efforts.length);
  const next: [string, string][] = [];
  // Queued work nobody is free to take: the same nudge the Crew page shows.
  const waiting = store.queuedForAnyone();
  const free = list.some((a) => a.active && !a.role && a.state === "idle");
  const spare = list.find((a) => !a.active && !a.role && a.state !== "working");
  if (waiting && !free && spare) {
    next.push([`crane agents configure ${spare.name.toLowerCase()} --active`, `${waiting} ${waiting === 1 ? "task" : "tasks"} waiting and no one is free`]);
  }
  const maintainer = list.find((a) => a.role && a.active);
  if (maintainer) next.push([`crane agents run ${maintainer.name.toLowerCase()}`, MAINTENANCE_ROLE[maintainer.role!].action.toLowerCase()]);
  if (other) next.push([`crane agents use ${other.name}`, `run new tasks on ${other.label}`]);
  if (tunable) next.push([`crane agents set ${tunable.name} --model <model> --effort <level>`, `choose ${tunable.label}'s model and effort`]);
  next.push([`crane do --agent <agent> "…"`, "pick the agent for one task"]);
  console.log(ui.hint(...next) + "\n");
}

function registerMemberCommands(agents: Command, { store, actions }: CliContext): void {
  agents
    .command("configure <member>")
    .description("Set a crew member's default agent, maintenance role, or active/on-call status")
    .option("--agent <agent>", "default agent, or default to follow the factory")
    .option("--role <role>", `maintenance role: ${MAINTENANCE_ROLES.join(" | ")}, or none`)
    .option("--active", "activate this member")
    .option("--on-call", "finish current work, then stop taking tasks")
    .action(async (member: string, opts: { agent?: string; role?: string; active?: boolean; onCall?: boolean }) => {
      try {
        if (opts.active && opts.onCall) throw new Error("Choose --active or --on-call");
        const a = crewMember(store, member);
        const updated = await actions.configureCrew(a.id, {
          defaultDriver: opts.agent,
          role: opts.role,
          active: opts.active ? true : opts.onCall ? false : undefined,
        });
        ui.ok(`Updated ${a.name}`);
        if (opts.role !== undefined && updated.role) {
          const role = MAINTENANCE_ROLE[updated.role];
          console.log(`  ${ui.dim(`${role.label}: ${role.summary} Takes only the runs you start.`)}`);
          console.log(ui.hint([`crane agents run ${a.name.toLowerCase()}`, role.action.toLowerCase()]) + "\n");
        }
      } catch (err) { ui.fail(errorMessage(err)); }
    });

  agents
    .command("run <member>")
    .description("Start a crew member's maintenance run (defaults to Crane's repo)")
    .option("--repo <repo>", "connected repo name or id")
    .option("--at <timestamp>", "start after an ISO timestamp with a timezone")
    .action(async (member: string, opts: { repo?: string; at?: string }) => {
      try {
        const a = crewMember(store, member);
        const t = await actions.runRole(a.id, { repoId: opts.repo, scheduledAt: opts.at });
        ui.ok(`${t.scheduledAt ? `Scheduled for ${new Date(t.scheduledAt).toLocaleString()}` : "Queued"} for ${a.name}: ${t.title}  ${ui.dim(`${t.id} · ${AUTONOMY_LABEL[t.autonomy]}`)}`);
        console.log(ui.hint([`crane watch ${t.id}`, "follow along"], [`crane show ${t.id}`, "see the result"]) + "\n");
      } catch (err) { ui.fail(errorMessage(err)); }
    });
}

function registerRoles(agents: Command, { store }: CliContext): void {
  agents
    .command("roles")
    .description("The maintenance roles a crew member can take")
    .action(() => {
      console.log(ui.section("Maintenance roles", MAINTENANCE_ROLES.length));
      for (const r of MAINTENANCE_ROLES) {
        const role = MAINTENANCE_ROLE[r];
        const who = store.listAgents().filter((a) => a.role === r).map((a) => a.name);
        console.log(`  ${pc.bold(r.padEnd(15))} ${role.summary}  ${ui.dim(`${AUTONOMY_LABEL[role.autonomy]}${who.length ? ` · ${who.join(", ")}` : ""}`)}`);
      }
      console.log("\n" + ui.hint(["crane agents configure <member> --role <role>", "dedicate a member to one"]) + "\n");
    });
}

function registerAgentSettings(agents: Command, { actions }: CliContext): void {
  agents
    .command("use")
    .description("Choose the agent new tasks run on")
    .argument("<agent>", DRIVER_NAMES.join(" | "))
    .action(async (name: string) => {
      try {
        const catalog = await actions.setDefaultDriver(name);
        const d = catalog.find((x) => x.isDefault)!;
        ui.ok(`Factory default set to ${d.label}. Crew preferences, task choices, and resumed sessions take priority.`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });

  agents
    .command("set")
    .description("Choose the model and effort an agent runs with")
    .argument("<agent>", DRIVER_NAMES.filter((n) => EFFORT_LEVELS[n].length).join(" | "))
    .option("--model <model>", "model name or alias, or default for the agent's own")
    .option(
      "--effort <level>",
      `${DRIVER_NAMES.filter((n) => EFFORT_LEVELS[n].length).map((n) => `${n}: ${EFFORT_LEVELS[n].join(", ")}`).join("; ")}; or default`,
    )
    .action(async (name: string, opts: { model?: string; effort?: string }) => {
      try {
        if (opts.model === undefined && opts.effort === undefined) throw new Error("Give --model, --effort, or both");
        const catalog = await actions.configureDriver(name, opts);
        const d = catalog.find((x) => x.name === name)!;
        ui.ok(`${d.label} runs on ${settingsLabel(d) ?? "its default model and effort"} from its next run.`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
}

function registerPostmortem(agents: Command, { store, actions }: CliContext): void {
  agents
    .command("postmortem")
    .description("Show or set who runs post-mortems and the defaults for new ones")
    .option("--agent <agent>", "agent name, or default to keep the merged task's agent")
    .option("--model <model>", "model name or alias, or default to follow the agent's settings")
    .option("--effort <level>", "effort level for the chosen agent, or default to follow its settings")
    .option("--crew <members>", "comma-separated crew members who run them, active or on-call, or default for any active member")
    .action((opts: { agent?: string; model?: string; effort?: string; crew?: string }) => {
      try {
        const defaults = opts.agent !== undefined || opts.model !== undefined || opts.effort !== undefined;
        const crew = opts.crew === undefined ? undefined : parsePostmortemCrew(store, opts.crew);
        const s = defaults || crew ? actions.configurePostmortem({ driver: opts.agent, model: opts.model, effort: opts.effort, crew }) : actions.postmortemSettings();
        console.log(`  Post-mortems: ${s.driver ? driverLabel(s.driver) : "merged task's agent"} · ${settingsLabel(s) ?? "agent settings"}`);
        console.log(`  Run by ${postmortemCrewLabel(store, s.crew)}`);
        if (defaults) ui.ok("Defaults saved for newly queued post-mortems.");
        if (crew) ui.ok("Saved who runs post-mortems. It applies to those already waiting too.");
      } catch (err) { ui.fail(errorMessage(err)); }
    });
}
