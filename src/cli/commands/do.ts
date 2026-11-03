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
  type TaskKind,
} from "@crane/contracts";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { checkScheduledAt } from "../../factory/actions.js";
import { draftTask } from "../../factory/instruct.js";
import { factoryIsRunning } from "../../factory/state.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { ACCEPT_HELP, AFTER_HELP, LOOK_FOR_HELP, collect, lookFor, repoName } from "./shared.js";

interface DoOptions {
  repo?: string; kind?: TaskKind; autonomy?: Autonomy; agent?: string; yes?: boolean; after: string[]; accept: string[];
  lookFor: string[]; at?: string; preApprove?: boolean;
}

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
    .option("--look-for <what>", LOOK_FOR_HELP, collect, [])
    .option("-y, --yes", "skip the confirmation step")
    .action((words: string[], opts: DoOptions) => instruct(ctx, words, opts));
}

async function instruct({ store, actions }: CliContext, words: string[], opts: DoOptions) {
  let preApprove = opts.preApprove ?? false;
  let lookouts = lookFor(opts.lookFor);
  let scheduledAt: string | null;
  try { scheduledAt = checkScheduledAt(opts.at); } catch (err) { return ui.fail(errorMessage(err)); }
  p.intro(`${ui.accent("▟")} ${pc.bold("New task")}`);
  let text = words.join(" ").trim();
  if (!text) {
    const answer = await p.text({
      message: "What should the factory do?",
      placeholder: "Investigate why the checkout tests are flaky",
      validate: (v) => (v?.trim() ? undefined : "Describe the work in a sentence or two"),
    });
    if (p.isCancel(answer)) return p.cancel("Nothing was created.");
    text = String(answer);
  }

  const repos = store.listRepos();
  const draft = draftTask(text, repos, { lastRepoId: store.getSetting("last_repo") });
  if (opts.repo) {
    const r = store.getRepo(opts.repo);
    if (!r) ui.fail(`No repo called ${opts.repo}. See \`crane repos\`.`);
    draft.repoId = r.id;
    draft.why.repo = "You chose it";
    if (r.isFactory) draft.kind = "factory_feature";
  }
  if (opts.kind) draft.kind = opts.kind;
  if (opts.autonomy) draft.autonomy = opts.autonomy;

  if (!draft.repoId && draft.kind !== "factory_feature") {
    const targets = repos;
    if (!targets.length) ui.fail("Connect a repo first: crane repos add <path>");
    const choice = await p.select({
      message: "Which repo?",
      options: targets.map((r) => ({ value: r.id, label: r.name, hint: r.isFactory ? "the factory itself" : r.path })),
    });
    if (p.isCancel(choice)) return p.cancel("Nothing was created.");
    draft.repoId = String(choice);
    draft.why.repo = "You chose it";
    if (store.getRepo(draft.repoId)?.isFactory) draft.kind = "factory_feature";
  }

  // The agent: the one asked for, else the factory's default. Only shown when there's a choice to make.
  const catalog = await actions.drivers();
  const choosable = choosableDrivers(catalog);
  const defaultAgent = catalog.find((d) => d.isDefault);
  let driver: string | null = null;
  if (opts.agent && opts.agent !== "default") {
    const d = catalog.find((x) => x.name === opts.agent);
    if (!d) ui.fail(`No agent called ${opts.agent}. Use one of: ${DRIVER_NAMES.join(", ")}`);
    if (!d.available) ui.fail(`${d.label} isn't installed here. ${d.hint}`);
    driver = d.name;
  }
  const agentLine = () =>
    driver
      ? `${ui.dim("Agent    ")} ${driverLabel(driver)}  ${ui.dim("You chose it")}`
      : `${ui.dim("Agent    ")} ${defaultAgent?.label ?? "The default"}  ${ui.dim("Your default agent")}`;

  const summary = [
    `${pc.bold(draft.title)}`,
    "",
    `${ui.dim("Repo     ")} ${repoName(store, draft.repoId) ?? "—"}  ${ui.dim(draft.why.repo)}`,
    `${ui.dim("Type     ")} ${KIND_LABEL[draft.kind]}  ${ui.dim(draft.why.kind)}`,
    `${ui.dim("Freedom  ")} ${AUTONOMY_LABEL[draft.autonomy]}  ${ui.dim(draft.why.autonomy)}`,
    ...(driver || choosable.length > 1 ? [agentLine()] : []),
    ...(scheduledAt ? [`${ui.dim("Start    ")} ${new Date(scheduledAt).toLocaleString()}  ${ui.dim("When an agent is free after this time")}`] : []),
    ...(draft.autonomy !== "observe" || preApprove ? [`${ui.dim("Merge    ")} ${preApprove ? "When it passes (pre-approved)" : "Wait for approval"}`] : []),
    ...(opts.after.length ? [`${ui.dim("After    ")} ${opts.after.join(", ")}  ${ui.dim("Starts once they land")}`] : []),
    ...opts.accept.map((c, i) => `${ui.dim(i ? "         " : "Accept   ")} ${c}`),
    ...(lookouts.length ? [`${ui.dim("Look for ")} ${lookoutsLabel(lookouts)}  ${ui.dim("Reported as findings")}`] : []),
  ].join("\n");
  p.note(summary, "Here's what I understood");

  if (!opts.yes) {
    const next = await p.select({
      message: scheduledAt ? "Schedule it?" : "Start it?",
      options: [
        { value: "go", label: scheduledAt ? "Schedule task" : "Start task" },
        { value: "schedule", label: "Change the start time" },
        ...(draft.autonomy !== "observe" ? [{ value: "preApprove", label: "Change whether it merges when it passes" }] : []),
        { value: "autonomy", label: "Change how much freedom it has" },
        { value: "kind", label: "Change the type" },
        ...(choosable.length > 1 ? [{ value: "agent", label: "Change the agent" }] : []),
        { value: "lookouts", label: "Change what else it looks for" },
        { value: "stop", label: "Don't start" },
      ],
    });
    if (p.isCancel(next) || next === "stop") return p.cancel("Nothing was created.");
    if (next === "preApprove") {
      const merge = await p.select({
        message: "Merge when it passes?",
        initialValue: preApprove,
        options: [
          { value: false, label: "Wait for approval" },
          { value: true, label: "Pre-approve", hint: "Merge once its run, acceptance criteria, and checks pass; waive visual review including conflict resolutions" },
        ],
      });
      if (p.isCancel(merge)) return p.cancel("Nothing was created.");
      preApprove = merge;
    }
    if (next === "schedule") {
      const at = await p.text({
        message: "Start time (ISO timestamp with timezone, or now)",
        placeholder: "2030-06-15T09:00:00-04:00",
        initialValue: scheduledAt ?? "now",
        validate: (v) => {
          if (v?.trim() === "now") return;
          try { checkScheduledAt(v?.trim() ?? ""); } catch (err) { return errorMessage(err); }
        },
      });
      if (p.isCancel(at)) return p.cancel("Nothing was created.");
      scheduledAt = at.trim() === "now" ? null : checkScheduledAt(at.trim());
    }
    if (next === "agent") {
      const a = await p.select({
        message: "Which agent?",
        initialValue: driver ?? defaultAgent?.name ?? choosable[0]!.name,
        options: choosable.map((d) => ({ value: d.name, label: d.label, hint: d.isDefault ? "your default" : d.hint })),
      });
      if (p.isCancel(a)) return p.cancel("Nothing was created.");
      // Picking the default leaves the task on "whatever the default is", like not choosing at all.
      driver = a === defaultAgent?.name ? null : String(a);
    }
    if (next === "autonomy") {
      const a = await p.select({
        message: "How much freedom?",
        initialValue: draft.autonomy,
        options: [
          { value: "observe", label: AUTONOMY_LABEL.observe, hint: "read-only, reports back" },
          { value: "propose", label: AUTONOMY_LABEL.propose, hint: "changes on a branch, waits for you" },
          { value: "act", label: AUTONOMY_LABEL.act, hint: "changes on a branch, no review step" },
        ],
      });
      if (p.isCancel(a)) return p.cancel("Nothing was created.");
      draft.autonomy = a as Autonomy;
      if (draft.autonomy === "observe") preApprove = false;
    }
    if (next === "kind") {
      const k = await p.select({
        message: "What type of work?",
        initialValue: draft.kind,
        options: (Object.keys(KIND_LABEL) as TaskKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] })),
      });
      if (p.isCancel(k)) return p.cancel("Nothing was created.");
      draft.kind = k as TaskKind;
    }
    if (next === "lookouts") {
      const l = await p.multiselect({
        message: "What else should it look out for? It reports what it finds as findings.",
        initialValues: lookouts,
        required: false,
        options: LOOKOUTS.map((l) => ({ value: l, label: LOOKOUT[l].label, hint: LOOKOUT[l].hint })),
      });
      if (p.isCancel(l)) return p.cancel("Nothing was created.");
      lookouts = l;
    }
  }

  try {
    const m = actions.createTask({ ...draft, driver, prerequisites: opts.after, acceptance: opts.accept, lookouts, scheduledAt, preApprove });
    const waiting = store.unmetPrerequisites(m).map((t) => t.id);
    p.outro(
      `${pc.green("✓")} ${m.scheduledAt ? `Task scheduled for ${new Date(m.scheduledAt).toLocaleString()}. Prerequisites still apply` : waiting.length ? `Task queued. It starts once ${waiting.join(", ")} land${waiting.length === 1 ? "s" : ""}` : "Task queued"}  ${ui.dim(m.id)}\n   ${ui.dim("follow along:")} crane watch ${m.id}${
        m.preApprovedAt ? "\n   Pre-approved: merges when its run and checks pass; visual review is waived, including conflict resolutions." : ""
      }${
        factoryIsRunning(store) ? "" : `\n   ${ui.accent("!")} The factory is off. Run ${pc.bold("crane serve")} to start the agents.`
      }`,
    );
  } catch (err) {
    ui.fail(errorMessage(err));
  }
}
