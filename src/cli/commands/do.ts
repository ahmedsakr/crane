import {
  AUTONOMY_LABEL,
  DRIVER_NAMES,
  KIND_LABEL,
  LOOKOUT,
  LOOKOUTS,
  choosableDrivers,
  driverLabel,
  errorMessage,
  lookoutsLabel,
  type Autonomy,
  type DriverInfo,
  type Lookout,
  type Task,
  type TaskDraft,
  type TaskKind,
} from "@crane/contracts";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Store } from "@crane/storage";
import { checkScheduledAt } from "../../factory/actions.js";
import { draftTask } from "../../factory/instruct.js";
import { factoryIsRunning } from "../../factory/state.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { ACCEPT_CHECK_HELP, ACCEPT_HELP, AFTER_HELP, LOOK_FOR_HELP, collect, lookFor, repoName, startsOnce } from "./shared.js";

interface DoOptions {
  repo?: string; kind?: TaskKind; autonomy?: Autonomy; agent?: string; yes?: boolean; after: string[]; accept: string[]; acceptCheck: string[];
  lookFor: string[]; at?: string; preApprove?: boolean;
}

/** What the operator has settled on so far; the menu changes one of these. */
interface Choices {
  draft: TaskDraft;
  /** The agent asked for, or null for the factory's default. */
  driver: string | null;
  scheduledAt: string | null;
  preApprove: boolean;
  lookouts: Lookout[];
}

/** The agents a task could run on here. */
interface Agents {
  choosable: DriverInfo[];
  defaultAgent: DriverInfo | undefined;
}

const NOTHING_CREATED = "Nothing was created.";

/** `crane do`: instruct the factory. */
export function registerDo(program: Command, ctx: CliContext): void {
  program
    .command("do")
    .alias("instruct")
    .description("Tell the factory what to do, in plain words")
    .argument("[instruction...]", 'e.g. "investigate the flaky checkout tests in api"')
    .option("-r, --repo <repo>", "repo name or id")
    .option("-k, --kind <kind>", "maintenance | repo_feature | factory_feature")
    .option("-a, --autonomy <level>", "observe | propose | act")
    .option("--agent <agent>", `which agent works it: ${DRIVER_NAMES.join(" | ")} (default: the factory's default)`)
    .option("--at <timestamp>", "start no earlier than this ISO timestamp with timezone, e.g. 2030-06-15T09:00:00-04:00")
    .option("--pre-approve", "merge after checks and acceptance pass; waive visual review including conflict resolutions")
    .option("--after <id>", AFTER_HELP, collect, [])
    .option("--accept <criterion>", ACCEPT_HELP, collect, [])
    .option("--accept-check <command>", ACCEPT_CHECK_HELP, collect, [])
    .option("--look-for <what>", LOOK_FOR_HELP, collect, [])
    .option("-y, --yes", "skip the confirmation step")
    .action((words: string[], opts: DoOptions) => instruct(ctx, words, opts));
}

async function instruct(ctx: CliContext, words: string[], opts: DoOptions) {
  const lookouts = lookFor(opts.lookFor);
  let scheduledAt: string | null;
  try { scheduledAt = checkScheduledAt(opts.at); } catch (err) { return ui.fail(errorMessage(err)); }
  p.intro(`${ui.accent("▟")} ${pc.bold("New task")}`);
  const text = await askInstruction(words);
  if (text === null) return p.cancel(NOTHING_CREATED);
  const draft = await resolveRepo(ctx.store, text, opts);
  if (!draft) return p.cancel(NOTHING_CREATED);
  const { agents, driver } = await resolveAgent(ctx, opts.agent);
  const choices: Choices = { draft, driver, scheduledAt, preApprove: opts.preApprove ?? false, lookouts };
  p.note(summaryLines(choices, agents, opts, repoName(ctx.store, draft.repoId)).join("\n"), "Here's what I understood");
  if (!opts.yes && !(await confirmOrChange(choices, agents))) return p.cancel(NOTHING_CREATED);
  createTask(ctx, choices, opts);
}

/** The instruction from the command line, or asked for. Null when the operator cancels. */
async function askInstruction(words: string[]): Promise<string | null> {
  const given = words.join(" ").trim();
  if (given) return given;
  const answer = await p.text({
    message: "What should the factory do?",
    placeholder: "Investigate why the checkout tests are flaky",
    validate: (v) => (v?.trim() ? undefined : "Describe the work in a sentence or two"),
  });
  return p.isCancel(answer) ? null : String(answer);
}

/** The draft with its repo settled: given with --repo, guessed, or asked for. Null when the operator cancels. */
async function resolveRepo(store: Store, text: string, opts: DoOptions): Promise<TaskDraft | null> {
  const repos = store.listRepos();
  const draft = draftTask(text, repos, { lastRepoId: store.getSetting("last_repo") });
  if (opts.repo) {
    const r = store.getRepo(opts.repo);
    if (!r) ui.fail(`No repo called ${opts.repo}. See \`crane repos\`.`);
    chooseRepo(draft, r.id, r.isFactory);
  }
  if (opts.kind) draft.kind = opts.kind;
  if (opts.autonomy) draft.autonomy = opts.autonomy;
  if (draft.repoId || draft.kind === "factory_feature") return draft;

  if (!repos.length) ui.fail("Connect a repo first: crane repos add <path>");
  const choice = await p.select({
    message: "Which repo?",
    options: repos.map((r) => ({ value: r.id, label: r.name, hint: r.isFactory ? "the factory itself" : r.path })),
  });
  if (p.isCancel(choice)) return null;
  chooseRepo(draft, String(choice), store.getRepo(String(choice))?.isFactory ?? false);
  return draft;
}

function chooseRepo(draft: TaskDraft, repoId: string, isFactory: boolean): void {
  draft.repoId = repoId;
  draft.why.repo = "You chose it";
  if (isFactory) draft.kind = "factory_feature";
}

/** The agent asked for, else the factory's default (null). Fails on an unknown or missing agent. */
async function resolveAgent({ actions }: CliContext, asked: string | undefined): Promise<{ agents: Agents; driver: string | null }> {
  const catalog = await actions.drivers();
  const agents = { choosable: choosableDrivers(catalog), defaultAgent: catalog.find((d) => d.isDefault) };
  if (!asked || asked === "default") return { agents, driver: null };
  const d = catalog.find((x) => x.name === asked);
  if (!d) ui.fail(`No agent called ${asked}. Use one of: ${DRIVER_NAMES.join(", ")}`);
  if (!d.available) ui.fail(`${d.label} isn't installed here. ${d.hint}`);
  return { agents, driver: d.name };
}

/** What the factory understood, one line per setting. The agent shows only when there's a choice to make. */
function summaryLines(choices: Choices, agents: Agents, opts: Pick<DoOptions, "after" | "accept">, repo: string | undefined): string[] {
  const { draft, driver, scheduledAt, preApprove, lookouts } = choices;
  const lines = [
    `${pc.bold(draft.title)}`,
    "",
    `${ui.dim("Repo     ")} ${repo ?? "—"}  ${ui.dim(draft.why.repo)}`,
    `${ui.dim("Type     ")} ${KIND_LABEL[draft.kind]}  ${ui.dim(draft.why.kind)}`,
    `${ui.dim("Freedom  ")} ${AUTONOMY_LABEL[draft.autonomy]}  ${ui.dim(draft.why.autonomy)}`,
  ];
  if (driver || agents.choosable.length > 1) lines.push(agentLine(driver, agents));
  if (scheduledAt) lines.push(`${ui.dim("Start    ")} ${new Date(scheduledAt).toLocaleString()}  ${ui.dim("When an agent is free after this time")}`);
  if (draft.autonomy !== "observe" || preApprove) lines.push(`${ui.dim("Merge    ")} ${preApprove ? "When it passes (pre-approved)" : "Wait for approval"}`);
  if (opts.after.length) lines.push(`${ui.dim("After    ")} ${opts.after.join(", ")}  ${ui.dim("Starts once they land")}`);
  lines.push(...opts.accept.map((c, i) => `${ui.dim(i ? "         " : "Accept   ")} ${c}`));
  if (lookouts.length) lines.push(`${ui.dim("Look for ")} ${lookoutsLabel(lookouts)}  ${ui.dim("Reported as findings")}`);
  return lines;
}

function agentLine(driver: string | null, { defaultAgent }: Agents): string {
  if (driver) return `${ui.dim("Agent    ")} ${driverLabel(driver)}  ${ui.dim("You chose it")}`;
  return `${ui.dim("Agent    ")} ${defaultAgent?.label ?? "The default"}  ${ui.dim("Your default agent")}`;
}

/** One menu change: false when the operator cancels it. */
type Change = (choices: Choices, agents: Agents) => Promise<boolean>;

/** Asks to start, or to change one setting first. False when the operator stops or cancels. */
async function confirmOrChange(choices: Choices, agents: Agents): Promise<boolean> {
  const scheduled = choices.scheduledAt !== null;
  const next = await p.select({
    message: scheduled ? "Schedule it?" : "Start it?",
    options: [
      { value: "go", label: scheduled ? "Schedule task" : "Start task" },
      { value: "schedule", label: "Change the start time" },
      ...(choices.draft.autonomy !== "observe" ? [{ value: "preApprove", label: "Change whether it merges when it passes" }] : []),
      { value: "autonomy", label: "Change how much freedom it has" },
      { value: "kind", label: "Change the type" },
      ...(agents.choosable.length > 1 ? [{ value: "agent", label: "Change the agent" }] : []),
      { value: "lookouts", label: "Change what else it looks for" },
      { value: "stop", label: "Don't start" },
    ],
  });
  if (p.isCancel(next) || next === "stop") return false;
  const change = CHANGES[next];
  return change ? change(choices, agents) : true;
}

const changePreApprove: Change = async (choices) => {
  const merge = await p.select({
    message: "Merge when it passes?",
    initialValue: choices.preApprove,
    options: [
      { value: false, label: "Wait for approval" },
      { value: true, label: "Pre-approve", hint: "Merge once its run, acceptance criteria, and checks pass; waive visual review including conflict resolutions" },
    ],
  });
  if (p.isCancel(merge)) return false;
  choices.preApprove = merge;
  return true;
};

const changeSchedule: Change = async (choices) => {
  const at = await p.text({
    message: "Start time (ISO timestamp with timezone, or now)",
    placeholder: "2030-06-15T09:00:00-04:00",
    initialValue: choices.scheduledAt ?? "now",
    validate: (v) => {
      if (v?.trim() === "now") return;
      try { checkScheduledAt(v?.trim() ?? ""); } catch (err) { return errorMessage(err); }
    },
  });
  if (p.isCancel(at)) return false;
  choices.scheduledAt = at.trim() === "now" ? null : checkScheduledAt(at.trim());
  return true;
};

const changeAgent: Change = async (choices, { choosable, defaultAgent }) => {
  const a = await p.select({
    message: "Which agent?",
    initialValue: choices.driver ?? defaultAgent?.name ?? choosable[0]!.name,
    options: choosable.map((d) => ({ value: d.name, label: d.label, hint: d.isDefault ? "your default" : d.hint })),
  });
  if (p.isCancel(a)) return false;
  // Picking the default leaves the task on "whatever the default is", like not choosing at all.
  choices.driver = a === defaultAgent?.name ? null : String(a);
  return true;
};

const changeAutonomy: Change = async (choices) => {
  const a = await p.select({
    message: "How much freedom?",
    initialValue: choices.draft.autonomy,
    options: [
      { value: "observe", label: AUTONOMY_LABEL.observe, hint: "read-only, reports back" },
      { value: "propose", label: AUTONOMY_LABEL.propose, hint: "changes on a branch, waits for you" },
      { value: "act", label: AUTONOMY_LABEL.act, hint: "changes on a branch, no review step" },
    ],
  });
  if (p.isCancel(a)) return false;
  choices.draft.autonomy = a as Autonomy;
  if (choices.draft.autonomy === "observe") choices.preApprove = false;
  return true;
};

const changeKind: Change = async (choices) => {
  const k = await p.select({
    message: "What type of work?",
    initialValue: choices.draft.kind,
    options: (Object.keys(KIND_LABEL) as TaskKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] })),
  });
  if (p.isCancel(k)) return false;
  choices.draft.kind = k as TaskKind;
  return true;
};

const changeLookouts: Change = async (choices) => {
  const l = await p.multiselect({
    message: "What else should it look out for? It reports what it finds as findings.",
    initialValues: choices.lookouts,
    required: false,
    options: LOOKOUTS.map((l) => ({ value: l, label: LOOKOUT[l].label, hint: LOOKOUT[l].hint })),
  });
  if (p.isCancel(l)) return false;
  choices.lookouts = l;
  return true;
};

const CHANGES: Record<string, Change | undefined> = {
  preApprove: changePreApprove,
  schedule: changeSchedule,
  agent: changeAgent,
  autonomy: changeAutonomy,
  kind: changeKind,
  lookouts: changeLookouts,
};

function createTask({ store, actions }: CliContext, choices: Choices, opts: DoOptions): void {
  try {
    const { draft, ...rest } = choices;
    const task = actions.createTask({ ...draft, ...rest, prerequisites: opts.after, acceptance: opts.accept, acceptanceChecks: opts.acceptCheck });
    const waiting = store.unmetPrerequisites(task).map((t) => t.id);
    p.outro(createdMessage(task, waiting, factoryIsRunning(store)));
  } catch (err) {
    ui.fail(errorMessage(err));
  }
}

/** The outro once a task exists: when it starts, how to follow it, and what still stands in its way. */
function createdMessage(task: Pick<Task, "id" | "scheduledAt" | "preApprovedAt">, waiting: string[], factoryRunning: boolean): string {
  const lines = [`${pc.green("✓")} ${queuedPhrase(task, waiting)}  ${ui.dim(task.id)}`, `   ${ui.dim("follow along:")} crane watch ${task.id}`];
  if (task.preApprovedAt) lines.push("   Pre-approved: merges when its run and checks pass; visual review is waived, including conflict resolutions.");
  if (!factoryRunning) lines.push(`   ${ui.accent("!")} The factory is off. Run ${pc.bold("crane serve")} to start the agents.`);
  return lines.join("\n");
}

function queuedPhrase(task: Pick<Task, "scheduledAt">, waiting: string[]): string {
  if (task.scheduledAt) return `Task scheduled for ${new Date(task.scheduledAt).toLocaleString()}. Prerequisites still apply`;
  return waiting.length ? `Task queued. ${startsOnce(waiting)}` : "Task queued";
}
