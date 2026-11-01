import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Store } from "../core/store.js";
import {
  ACTIVE_STATUSES,
  AUTONOMY_LABEL,
  DRIVER_NAMES,
  EFFORT_LEVELS,
  KIND_LABEL,
  LOOKOUT,
  LOOKOUTS,
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  RUN_KIND_LABEL,
  UNSHIPPED_STATUSES,
  acceptanceFor,
  choosableDrivers,
  driverLabel,
  lastMergeOutcome,
  lookoutsLabel,
  parseDiff,
  prerequisiteMet,
  ruleLabel,
  settingsLabel,
  type Autonomy,
  type DiffFile,
  type Lookout,
  type BlockedTool,
  type TaskKind,
  type TaskStatus,
} from "@crane/contracts";
import { OperatorActions, checkLookouts, checkScheduledAt, toRule } from "../factory/actions.js";
import { draftTask } from "../factory/instruct.js";
import { factoryDriverName, factoryIsRunning, factoryState } from "../factory/state.js";
import { DEFAULT_MAX_TURNS, DEFAULT_TIME_LIMIT_MIN } from "../factory/settings.js";
import { diffForTask } from "../factory/git.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../core/paths.js";
import { screenshotPath } from "../core/screenshots.js";
import * as ui from "./ui.js";

// Set by `runCli` before any command runs, so tests can hand the CLI their own store.
let store!: Store;
let actions!: OperatorActions;

const repoName = (id: string | null) => (id ? store.getRepo(id)?.name : undefined);

/** For options given more than once: `--after t-1 --after t-2`. */
const collect = (value: string, previous: string[]) => [...previous, value];
const AFTER_HELP = "wait for this task to land first; repeat for more";
const ACCEPT_HELP = "an observable condition the work must meet; repeat for more";
const LOOK_FOR_HELP = `what else the agent should look out for and report: ${LOOKOUTS.join(" | ")}; repeat or separate with commas`;
/** `--look-for refactoring,test_gaps --look-for improvements`, checked. Fails the command on an unknown name. */
const lookFor = (given: string[]): Lookout[] => {
  try {
    return checkLookouts(given.flatMap((g) => g.split(",")));
  } catch (err) {
    return ui.fail((err as Error).message);
  }
};

function factoryLine(): string {
  const running = factoryIsRunning(store);
  const paused = store.isPaused();
  if (!running) return `${pc.dim("○")} Factory is off  ${ui.dim("start it with")} crane serve`;
  if (paused) return `${ui.accent("◉")} Factory is paused  ${ui.dim("agents will finish current work, then wait")}`;
  return `${pc.green("◉")} Factory is running  ${ui.dim(`on ${driverLabel(factoryDriverName(store))}`)}`;
}

const program = new Command()
  .name("crane")
  .description("An autonomous software factory you steer.")
  .showSuggestionAfterError()
  .configureHelp({ sortSubcommands: false });

// ── crane (no args): the one screen you need ────────────────
program.action(() => {
  const o = store.overview(factoryState(store));
  const delta = o.shippedThisWeek - o.shippedLastWeek;
  const last24 = o.activity.slice(-24).map((b) => b.events + b.done * 5);

  console.log(`\n${ui.brand()}   ${factoryLine()}\n`);
  console.log(
    `  ${pc.bold(String(o.shippedThisWeek))} shipped this week  ${
      delta === 0 ? ui.dim("same as last week") : delta > 0 ? pc.green(`+${delta} vs last week`) : pc.red(`${delta} vs last week`)
    }`,
  );
  console.log(`  ${ui.sparkline(last24)}  ${ui.dim("activity, last 24h")}`);

  if (o.needsReview.length) {
    console.log(ui.section(ui.accent("Needs you"), o.needsReview.length));
    for (const m of o.needsReview.slice(0, 5)) console.log(ui.taskLine(m, repoName(m.repoId)));
  }
  if (o.inFlight.length) {
    console.log(ui.section("In flight", o.inFlight.length));
    for (const m of o.inFlight.slice(0, 5)) console.log(ui.taskLine(m, repoName(m.repoId)));
  }
  if (o.blocked.length) {
    console.log(ui.section(ui.accent("Blocked commands"), o.blocked.length));
    for (const b of o.blocked) console.log(ui.blockedLine(b));
  }
  if (!o.needsReview.length && !o.inFlight.length) {
    console.log(`\n  ${ui.dim("Nothing needs you and nothing is running.")}`);
  }

  console.log("");
  const next: [string, string][] = [];
  if (o.needsReview[0]) next.push([`crane show ${o.needsReview[0].id}`, "review the top item"]);
  if (o.blocked[0]) next.push([allowCommand(o.blocked[0]), `let agents run it in ${o.blocked[0].repoName}`]);
  next.push(['crane do "…"', "give the factory an instruction"]);
  if (!o.repos.some((r) => !r.isFactory)) next.push(["crane repos add <path>", "connect a codebase to work on"]);
  if (!o.factory.running) next.push(["crane serve", "start agents and open the dashboard"]);
  if (o.factory.factoryOutdated) next.push(["npm run build", "then restart the factory to load recent backend changes"]);
  else if (o.factory.uiOutdated) next.push(["npm run build", "the dashboard is older than its source; rebuild it"]);
  next.push(["crane help", "everything else"]);
  console.log(ui.hint(...next));
  console.log("");
});

// ── crane do: instruct the factory ──────────────────────────
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
  .option("--after <id>", AFTER_HELP, collect, [])
  .option("--accept <criterion>", ACCEPT_HELP, collect, [])
  .option("--look-for <what>", LOOK_FOR_HELP, collect, [])
  .option("-y, --yes", "skip the confirmation step")
  .action(async (words: string[], opts: {
    repo?: string; kind?: TaskKind; autonomy?: Autonomy; agent?: string; yes?: boolean; after: string[]; accept: string[];
    lookFor: string[]; at?: string;
  }) => {
    let lookouts = lookFor(opts.lookFor);
    let scheduledAt: string | null;
    try { scheduledAt = checkScheduledAt(opts.at); } catch (err) { return ui.fail((err as Error).message); }
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
      `${ui.dim("Repo     ")} ${repoName(draft.repoId) ?? "—"}  ${ui.dim(draft.why.repo)}`,
      `${ui.dim("Type     ")} ${KIND_LABEL[draft.kind]}  ${ui.dim(draft.why.kind)}`,
      `${ui.dim("Freedom  ")} ${AUTONOMY_LABEL[draft.autonomy]}  ${ui.dim(draft.why.autonomy)}`,
      ...(driver || choosable.length > 1 ? [agentLine()] : []),
      ...(scheduledAt ? [`${ui.dim("Start    ")} ${new Date(scheduledAt).toLocaleString()}  ${ui.dim("When an agent is free after this time")}`] : []),
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
          { value: "autonomy", label: "Change how much freedom it has" },
          { value: "kind", label: "Change the type" },
          ...(choosable.length > 1 ? [{ value: "agent", label: "Change the agent" }] : []),
          { value: "lookouts", label: "Change what else it looks for" },
          { value: "stop", label: "Don't start" },
        ],
      });
      if (p.isCancel(next) || next === "stop") return p.cancel("Nothing was created.");
      if (next === "schedule") {
        const at = await p.text({
          message: "Start time (ISO timestamp with timezone, or now)",
          placeholder: "2030-06-15T09:00:00-04:00",
          initialValue: scheduledAt ?? "now",
          validate: (v) => {
            if (v?.trim() === "now") return;
            try { checkScheduledAt(v?.trim() ?? ""); } catch (err) { return (err as Error).message; }
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
      const m = actions.createTask({ ...draft, driver, prerequisites: opts.after, acceptance: opts.accept, lookouts, scheduledAt });
      const waiting = store.unmetPrerequisites(m).map((t) => t.id);
      p.outro(
        `${pc.green("✓")} ${m.scheduledAt ? `Task scheduled for ${new Date(m.scheduledAt).toLocaleString()}. Prerequisites still apply` : waiting.length ? `Task queued. It starts once ${waiting.join(", ")} land${waiting.length === 1 ? "s" : ""}` : "Task queued"}  ${ui.dim(m.id)}\n   ${ui.dim("follow along:")} crane watch ${m.id}${
          factoryIsRunning(store) ? "" : `\n   ${ui.accent("!")} The factory is off. Run ${pc.bold("crane serve")} to start the agents.`
        }`,
      );
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

// ── crane tasks ─────────────────────────────────────────────
program
  .command("tasks")
  // `missions` is the old name, kept so muscle memory still works.
  .aliases(["ls", "missions"])
  .description("List tasks (open ones by default)")
  .option("-a, --all", "include finished tasks")
  .option("-s, --status <statuses>", "comma-separated, e.g. needs_review,failed")
  .option("-r, --repo <repo>", "only this repo")
  .option("-n, --limit <n>", "how many to list, newest first", "50")
  .option("--json", "print the tasks as JSON, with each one's branch and worktree")
  .action((opts: { all?: boolean; status?: string; repo?: string; limit: string; json?: boolean }) => {
    const status = opts.status
      ? (opts.status.split(",") as TaskStatus[])
      : opts.all
        ? undefined
        : (["needs_review", "merging", "running", "queued"] as TaskStatus[]);
    const repoId = opts.repo ? (store.getRepo(opts.repo) ?? ui.fail(`No repo called ${opts.repo}. See \`crane repos\`.`)).id : undefined;
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) ui.fail(`--limit takes a whole number above 0, not ${opts.limit}`);
    const list = store.listTasks({ status, repoId, limit });
    if (opts.json) {
      console.log(JSON.stringify(list.map((m) => ({ ...m, repo: repoName(m.repoId) ?? null })), null, 2));
      return;
    }
    if (!list.length) {
      console.log(`\n  ${ui.dim(opts.all ? "No tasks yet." : "No open tasks.")}  ${ui.dim("Start one with")} crane do "…"\n`);
      return;
    }
    const groups = new Map<TaskStatus, typeof list>();
    for (const m of list) groups.set(m.status, [...(groups.get(m.status) ?? []), m]);
    const order: TaskStatus[] = [
      "needs_review",
      "merging",
      "running",
      "queued",
      "failed",
      "merged",
      "done",
      "approved",
      "rejected",
      "cancelled",
    ];
    for (const s of order) {
      const g = groups.get(s);
      if (!g) continue;
      console.log(ui.section(ui.statusText(s), g.length));
      for (const m of g) console.log(ui.taskLine(m, repoName(m.repoId)));
    }
    console.log("");
  });

// ── crane show ──────────────────────────────────────────────
program
  .command("show")
  .description("Show a task: what it found and what it needs from you")
  .argument("<id>")
  .option("-e, --events", "show the full activity log")
  .action((id: string, opts: { events?: boolean }) => {
    const m = store.getTask(id) ?? ui.fail(`No task ${id}`);
    const repo = m.repoId ? store.getRepo(m.repoId) : null;
    console.log(`\n${ui.statusDot(m.status)} ${pc.bold(m.title)}`);
    console.log(
      ui.dim(
        `  ${m.id} · ${ui.kindLabel(m)} · ${repoName(m.repoId) ?? "—"} · ${AUTONOMY_LABEL[m.autonomy]} · ${ui.ago(m.createdAt)}`,
      ),
    );
    const runs = store.listRuns(m.id);
    const cost = m.costUsd ? ` · ${ui.usd(m.costUsd)}${runs.length > 1 ? ` over ${runs.length} runs` : ""}` : "";
    const ran = store.lastWorkDriver(m.id);
    const agent = m.driver ?? ran;
    const on = agent && agent !== "unknown" ? ` · on ${driverLabel(agent)}` : "";
    const member = m.assignee ? store.listAgents().find((a) => a.id === m.assignee) : null;
    const forMember = member ? ` · for ${member.name}${m.status === "queued" && !member.active ? " (on-call)" : ""}` : "";
    const preApproved = m.preApprovedAt && ["queued", "running"].includes(m.status) ? " · pre-approved" : "";
    console.log(`  ${ui.statusText(m.status)}${ui.dim(forMember + on + cost + preApproved)}`);
    if (settingsLabel(m)) console.log(ui.dim(`  Model settings: ${settingsLabel(m)}`));
    if (m.lookouts.length) console.log(ui.dim(`  Also looks for: ${lookoutsLabel(m.lookouts)}`));
    if (m.scheduledAt) console.log(ui.dim(`  Start no earlier than: ${new Date(m.scheduledAt).toLocaleString()} (${m.scheduledAt})`));

    const prerequisites = store.prerequisiteStates(m);
    const waiting = store.unmetPrerequisites(m);
    if (prerequisites.length) {
      const title = m.prerequisitesWaivedAt
        ? "Prerequisites, waived"
        : waiting.length && m.status === "queued" ? ui.accent("Waiting for prerequisites") : "Prerequisites";
      console.log(ui.section(title, prerequisites.length));
      for (const t of prerequisites) {
        console.log(`  ${t.met ? pc.green("✓") : ui.dim("○")} ${t.id}  ${t.title}  ${t.met ? ui.dim("landed") : ui.statusText(t.status)}`);
      }
    }
    if (m.acceptance.length) {
      console.log(ui.section("Acceptance criteria", m.acceptance.length));
      m.acceptance.forEach((c, i) => {
        const said = m.report ? acceptanceFor(m.report, c) : undefined;
        const mark = !m.report ? ui.dim(String(i + 1)) : said?.met ? pc.green("✓") : pc.red("✕");
        console.log(`  ${mark}  ${c}${m.report && !said ? ui.dim("  not reported") : ""}`);
        if (said?.evidence) console.log(ui.wrap(said.evidence, 5));
      });
    }

    if (m.report) {
      console.log(ui.section("Summary"));
      console.log(ui.wrap(m.report.summary, 2));
      if (m.report.screenshots?.length) {
        console.log(ui.section("Screenshots", m.report.screenshots.length));
        for (const image of m.report.screenshots) {
          const path = screenshotPath(m.id, image.path);
          if (path) console.log(`  ${image.caption}\n  ${ui.dim(path)}`);
        }
      }
      if (m.report.findings.length) {
        console.log(ui.section("Findings", m.report.findings.length));
        m.report.findings.forEach((f, i) => {
          console.log(`  ${ui.accent(String(i + 1))}  ${pc.bold(f.title)}  ${ui.dim(`${f.impact} impact · ${f.effort} effort`)}`);
          console.log(ui.wrap(f.detail, 5));
        });
      }
      if (m.report.changedFiles.length) {
        console.log(ui.section("Changed files", m.report.changedFiles.length));
        for (const f of m.report.changedFiles.slice(0, 12)) console.log(`  ${ui.dim("·")} ${f}`);
      }
    }

    if (opts.events && runs.length) {
      console.log(ui.section("Runs", runs.length));
      for (const r of runs) {
        const tokens = r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens;
        console.log(
          `  ${RUN_KIND_LABEL[r.kind].padEnd(18)} ${(r.costStatus === "unknown" ? r.costUsd ? `${ui.usd(r.costUsd)} + unknown` : "Unknown" : `${r.costStatus === "estimated" ? "~" : ""}${ui.usd(r.costUsd)}`).padStart(8)}  ${ui.dim(
            [r.outcome, r.driver === "unknown" ? null : driverLabel(r.driver), r.model, r.turns ? `${r.turns} turns` : null, tokens ? `${ui.compact(tokens)} tokens` : null, ui.ago(r.startedAt)]
              .filter(Boolean)
              .join(" · "),
          )}`,
        );
      }
    }

    const blocked = store.blockedTools({ taskId: m.id, ...(m.repoId ? { repoId: m.repoId } : {}) });
    if (blocked.length) {
      console.log(ui.section(ui.accent("Blocked"), blocked.length));
      for (const b of blocked) console.log(ui.blockedLine(b));
    }

    const events = store.listEvents(m.id);
    const shown = opts.events ? events : events.filter((e) => e.type !== "tool").slice(-6);
    console.log(ui.section("Activity", events.length));
    for (const e of shown) console.log("  " + ui.eventLine(e));
    if (!opts.events && events.length > shown.length) console.log(ui.dim(`  … crane show ${m.id} --events for all of it`));

    console.log("");
    const merge = lastMergeOutcome(events);
    const main = repo?.defaultBranch ?? "main";
    if (merge?.error) {
      console.log(`\n  ${pc.red("✕")} ${pc.bold(`Couldn't merge into ${main}`)}`);
      console.log(ui.wrap(merge.error, 4));
    }

    const next: [string, string][] = [];
    if (m.status === "needs_review") {
      next.push([`crane approve ${m.id}`, m.branch ? `merge into ${main} and push` : "mark as reviewed"]);
      if (m.branch) next.push([`crane approve ${m.id} --no-merge`, `approve only, keep ${m.branch}`]);
      next.push([`crane decline ${m.id}`, m.branch ? "discard the branch" : "dismiss"]);
      if (m.branch) next.push([`crane diff ${m.id}`, "see the changes"]);
      if (m.report?.findings.length && m.autonomy === "observe") next.push([`crane follow-up ${m.id} 1`, "act on finding 1"]);
    } else if (m.status === "running" || m.status === "queued") {
      if (m.status === "queued" && waiting.length) {
        next.push([`crane waive ${m.id} -m "…"`, `start it without ${waiting.map((t) => t.id).join(", ")}, accepting a reduced scope`]);
      }
      next.push([`crane watch ${m.id}`, "follow along live"]);
      if (m.status === "running" && m.branch) next.push([`crane diff ${m.id}`, "see the changes so far"]);
      next.push([`crane cancel ${m.id}`, "stop it"]);
      if (m.autonomy !== "observe") {
        next.push(m.preApprovedAt
          ? [`crane pre-approve ${m.id} --undo`, "wait for your review instead of merging"]
          : [`crane pre-approve ${m.id}`, `merge into ${main} once its checks pass`]);
      }
    } else if (m.status === "merging") {
      next.push([`crane watch ${m.id}`, "follow the merge"]);
    } else if (m.status === "failed" || m.status === "cancelled") {
      next.push([`crane retry ${m.id}`, "run it again"]);
    } else if ((m.status === "approved" || m.status === "done") && m.branch) {
      next.push([`crane merge ${m.id}`, `merge into ${main} and push`]);
    } else if (m.status === "merged" && merge?.checkoutBehind) {
      next.push([`git -C ${merge.checkoutBehind} pull --ff-only`, "catch your checkout up, once it's clean"]);
    }
    if (blocked[0]) next.push([allowCommand(blocked[0], m.id), `let agents run it in ${blocked[0].repoName}`]);
    if (next.length) console.log(ui.hint(...next) + "\n");
  });

// ── crane watch ─────────────────────────────────────────────
program
  .command("watch")
  .description("Follow a task, or the whole factory, live")
  .argument("[id]", "task id; omit to watch everything")
  .action(async (id?: string) => {
    const m = id ? store.getTask(id) ?? ui.fail(`No task ${id}`) : null;
    console.log(`\n${ui.brand()}  ${m ? pc.bold(m.title) : "Watching the factory"}  ${ui.dim("ctrl-c to stop")}\n`);
    let cursor = 0;
    if (m) {
      for (const e of store.listEvents(m.id)) {
        console.log(ui.eventLine(e));
        cursor = e.id;
      }
    } else {
      cursor = store.latestEventId();
    }
    const titles = new Map<string, string>();
    for (;;) {
      const events = m ? store.listEvents(m.id, cursor) : store.eventsSince(cursor);
      for (const e of events) {
        if (!m) {
          if (!titles.has(e.taskId)) titles.set(e.taskId, store.getTask(e.taskId)?.title ?? e.taskId);
          console.log(`${ui.dim(ui.truncate(titles.get(e.taskId)!, 22).padEnd(22))} ${ui.eventLine(e)}`);
        } else console.log(ui.eventLine(e));
        cursor = e.id;
      }
      if (m) {
        const now = store.getTask(m.id)!;
        if (!ACTIVE_STATUSES.includes(now.status)) {
          console.log(`\n${ui.statusDot(now.status)} ${ui.statusText(now.status)}  ${ui.dim(`crane show ${m.id}`)}\n`);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  });

// ── review actions ──────────────────────────────────────────
const act = (name: string, desc: string, fn: (id: string, note?: string) => Promise<unknown> | unknown, done: string) =>
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
        ui.fail((err as Error).message);
      }
    });

program
  .command("approve")
  .description("Approve a task that's waiting for you, and merge and push its branch")
  .argument("<id>")
  .option("-m, --message <note>", "leave a note on the task")
  .option("--no-merge", "approve only: keep the branch for you to merge yourself")
  .action(async (id: string, opts: { message?: string; merge: boolean }) => {
    try {
      const m = await actions.approve(id, opts.message, { merge: opts.merge });
      if (m.status === "merging") mergeQueued(m.id);
      else ui.ok(`Approved ${ui.dim(m.id)}${m.branch ? `  ${ui.dim(`branch ${m.branch} is kept`)}` : ""}`);
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

program
  .command("merge")
  .description("Merge an approved task's branch into the default branch and push it")
  .argument("<id>")
  .action(async (id: string) => {
    try {
      mergeQueued((await actions.merge(id)).id);
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

program
  .command("pre-approve")
  .description("Approve a queued or running task ahead of time, so it merges once its checks pass")
  .argument("<id>")
  .option("-m, --message <note>", "leave a note on the task")
  .option("--undo", "take the pre-approval back, so it waits for your review")
  .action((id: string, opts: { message?: string; undo?: boolean }) => {
    try {
      if (opts.undo) {
        const m = actions.undoPreApproval(id);
        ui.ok(`Undid pre-approval. It waits for your review  ${ui.dim(m.id)}`);
        return;
      }
      const m = actions.preApprove(id, opts.message);
      const main = (m.repoId && store.getRepo(m.repoId)?.defaultBranch) || "main";
      ui.ok(`Pre-approved. Crane merges it into ${main} once its checks pass  ${ui.dim(m.id)}`);
      console.log(ui.hint([`crane watch ${m.id}`, "follow along live"], [`crane pre-approve ${m.id} --undo`, "wait for review instead"]));
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

function mergeQueued(id: string) {
  const m = store.getTask(id)!;
  const main = (m.repoId && store.getRepo(m.repoId)?.defaultBranch) || "main";
  ui.ok(`Approved. Merging into ${main}  ${ui.dim(m.id)}`);
  if (!factoryIsRunning(store)) console.log(`  ${ui.accent("!")} The factory is off. Run ${pc.bold("crane serve")} to merge it.`);
  else if (store.isPaused()) console.log(`  ${ui.accent("!")} The factory is paused. It merges when you ${pc.bold("crane resume")}.`);
  console.log(ui.hint([`crane watch ${m.id}`, "follow the merge"]));
}

act("decline", "Decline a task and discard its branch", (id, n) => actions.reject(id, n), "Declined");
act("cancel", "Stop a queued or running task", (id) => actions.cancel(id), "Cancelled");
program
  .command("schedule")
  .description("Change a queued task's start time; use now to clear it (prerequisites still apply)")
  .argument("<id>")
  .argument("<timestamp>", "ISO timestamp with timezone, or now")
  .action((id: string, timestamp: string) => {
    try {
      const task = actions.schedule(id, timestamp === "now" ? null : timestamp);
      ui.ok(task.scheduledAt ? `Scheduled for ${new Date(task.scheduledAt).toLocaleString()}  ${ui.dim(task.id)}` : `Start time cleared. Prerequisites still apply  ${ui.dim(task.id)}`);
    } catch (err) { ui.fail((err as Error).message); }
  });
act(
  "waive",
  "Waive a queued task's prerequisites that haven't landed, approving a reduced scope so it starts without them",
  (id, n) => actions.waivePrerequisites(id, n),
  "Waived prerequisites. Its start time still applies",
);

program
  .command("retry")
  .description("Run a task again from scratch")
  .argument("<id>")
  .option("--agent <agent>", `run it on another agent: ${DRIVER_NAMES.join(" | ")} | default`)
  .action((id: string, opts: { agent?: string }) => {
    try {
      const m = actions.retry(id, { driver: opts.agent });
      ui.ok(`Queued again as ${m.id}${m.driver ? ` on ${driverLabel(m.driver)}` : ""}`);
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

program
  .command("follow-up")
  .description("Turn a finding into a task that makes the change")
  .argument("<id>")
  .argument("<finding>", "finding number, as shown in crane show")
  .option("--agent <agent>", `run it on an agent: ${DRIVER_NAMES.join(" | ")} | default`)
  .option("--model <model>", "model for this follow-up only; requires a chosen agent")
  .option("--effort <level>", "model effort for this follow-up only; requires a chosen agent")
  .option("--after <id>", AFTER_HELP, collect, [])
  .option("--accept <criterion>", ACCEPT_HELP, collect, [])
  .option("--look-for <what>", LOOK_FOR_HELP, collect, [])
  .action((id: string, n: string, opts: {
    agent?: string; model?: string; effort?: string; after: string[]; accept: string[]; lookFor: string[];
  }) => {
    try {
      const m = actions.followUp(id, Number(n) - 1, {
        driver: opts.agent, model: opts.model, effort: opts.effort, prerequisites: opts.after, acceptance: opts.accept,
        lookouts: lookFor(opts.lookFor),
      });
      const waiting = store.unmetPrerequisites(m).map((t) => t.id);
      ui.ok(`${waiting.length ? `Queued ${m.id}. It starts once ${waiting.join(", ")} land${waiting.length === 1 ? "s" : ""}` : `Started ${m.id}`}  ${ui.dim(m.title)}`);
      // The web form waits for an unlanded parent by default; here it's a hint, so scripts keep their behaviour.
      const parent = store.getTask(id);
      if (parent?.branch && !prerequisiteMet(parent) && !UNSHIPPED_STATUSES.includes(parent.status) && !m.prerequisites.includes(parent.id)) {
        console.log(ui.dim(`  It starts from the default branch, without ${parent.id}'s unmerged changes. To wait for them, cancel it and add --after ${parent.id}.`));
      }
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

program
  .command("diff")
  .description("Show the changes a task made on its branch, or has made so far while it runs")
  .argument("<id>")
  .option("--files", "list the changed files with lines added and removed")
  .option("--file <path>", "show the changes to one file")
  .action(async (id: string, opts: { files?: boolean; file?: string }) => {
    const m = store.getTask(id) ?? ui.fail(`No task ${id}`);
    const repo = m.repoId ? store.getRepo(m.repoId) : null;
    if (!repo || !m.branch) ui.fail("This task didn't change any code.");
    const merged = m.status === "merged" ? lastMergeOutcome(store.listEvents(m.id))?.commit : null;
    const { diff, live } = await diffForTask(repo, m, merged);
    if (live) console.log(ui.dim("Changes so far, uncommitted work included. It's still running.\n"));
    if (!diff) return console.log(ui.dim(live ? "No changes yet." : "No changes."));
    if (opts.files || opts.file) {
      const { files, notes } = parseDiff(diff);
      const stat = (f: DiffFile) => (f.binary ? ui.dim("binary") : `${pc.green(`+${f.additions}`)} ${pc.red(`-${f.deletions}`)}`);
      const name = (f: DiffFile) => `${f.oldPath ? `${f.oldPath} → ` : ""}${f.path}${f.status === "modified" ? "" : ui.dim(` (${f.status})`)}`;
      const show = (f: DiffFile) => `crane diff ${m.id} --file ${/[\s"'$`\\]/.test(f.path) ? JSON.stringify(f.path) : f.path}`;
      if (!opts.file) {
        for (const f of files) console.log(`${stat(f)}  ${name(f)}`);
        for (const n of notes) console.log(ui.dim(n));
        if (files[0]) console.log("\n" + ui.hint([show(files[0]), "see one file's changes"]));
        return;
      }
      const f = files.find((x) => x.path === opts.file || x.oldPath === opts.file);
      if (!f) ui.fail(`This task didn't change ${opts.file}. Run crane diff ${m.id} --files to list what it did.`);
      console.log(`${pc.bold(name(f))}  ${stat(f)}`);
      if (f.binary || !f.hunks.length) console.log(ui.dim(f.binary ? "A binary file. Its contents aren't shown." : "No line changes."));
      for (const h of f.hunks) {
        console.log(pc.cyan(h.header));
        for (const l of h.lines) {
          const sign = { add: "+", del: "-", context: " ", note: "\\ " }[l.kind];
          const text = sign + l.text;
          console.log(l.kind === "add" ? pc.green(text) : l.kind === "del" ? pc.red(text) : l.kind === "note" ? ui.dim(text) : text);
        }
      }
      const at = files.indexOf(f);
      const next = files[at + 1];
      if (next) console.log("\n" + ui.hint([show(next), `next file (${at + 2} of ${files.length})`]));
      return;
    }
    for (const line of diff.split("\n")) {
      console.log(
        line.startsWith("+") && !line.startsWith("+++")
          ? pc.green(line)
          : line.startsWith("-") && !line.startsWith("---")
            ? pc.red(line)
            : line.startsWith("@@")
              ? pc.cyan(line)
              : line.startsWith("diff ")
                ? pc.bold(line)
                : line,
      );
    }
  });

// ── repos ───────────────────────────────────────────────────
const repos = program.command("repos").description("The codebases the factory works on");
repos.action(() => {
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
});
repos
  .command("add")
  .description("Connect a git repository")
  .argument("<path>")
  .option("-n, --name <name>", "what to call it")
  .action(async (path: string, opts: { name?: string }) => {
    try {
      const r = await actions.connectRepo(path, opts.name);
      ui.ok(`Connected ${pc.bold(r.name)}  ${ui.dim(`${r.path} · ${r.defaultBranch}`)}`);
      console.log(ui.hint([`crane do "investigate open maintenance work in ${r.name}"`, "a good first task"]));
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });
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

// ── blocked commands and per-repo tools ─────────────────────
function allowCommand(b: BlockedTool, taskId?: string): string {
  const what = b.rule.startsWith("Bash(") ? b.label : b.rule;
  return `crane allow ${JSON.stringify(what)} -r ${b.repoName}${taskId ? ` -t ${taskId}` : ""}`;
}

/** The repo a rule is about: the one named, or the only one where it's been blocked. */
function repoForRule(input: string, repo?: string) {
  if (repo) return store.getRepo(repo) ?? ui.fail(`No repo called ${repo}. See \`crane repos\`.`);
  const rule = toRule(input);
  const where = [...new Set(store.blockedTools().filter((b) => b.rule === rule).map((b) => b.repoId))];
  if (where.length === 1) return store.getRepo(where[0]!)!;
  ui.fail(`Which repo? Add --repo <name>.${where.length ? "" : " Agents haven't been blocked from this anywhere yet."}`);
}

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

program
  .command("allow")
  .description("Let agents in a repo run a command they were blocked from")
  .argument("<command>", 'a command, e.g. "npm ci", or a rule, e.g. "Bash(npm ci:*)"')
  .option("-r, --repo <repo>", "repo name or id")
  .option("-t, --task <id>", "note it on this task")
  .action((input: string, opts: { repo?: string; task?: string }) => {
    try {
      const r = repoForRule(input, opts.repo);
      actions.allowTool(r.id, input, opts.task);
      ui.ok(`Allowed ${pc.bold(ruleLabel(toRule(input)))} for ${r.name}  ${ui.dim("agents can run it from their next task")}`);
    } catch (err) {
      ui.fail((err as Error).message);
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
      const r = repoForRule(input, opts.repo);
      actions.keepBlocked(r.id, input, opts.task);
      ui.ok(`Kept ${pc.bold(ruleLabel(toRule(input)))} blocked for ${r.name}`);
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

program
  .command("disallow")
  .description("Stop allowing a command you allowed for a repo")
  .argument("<command>")
  .requiredOption("-r, --repo <repo>", "repo name or id")
  .action((input: string, opts: { repo: string }) => {
    try {
      const r = repoForRule(input, opts.repo);
      actions.disallowTool(r.id, input);
      ui.ok(`Stopped allowing ${pc.bold(ruleLabel(toRule(input)))} for ${r.name}`);
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

// ── agents & factory control ────────────────────────────────
const agents = program
  .command("agents")
  .description("Who's on the crew, and which agent they run on")
  .action(async () => {
    console.log(`\n${factoryLine()}`);
    const list = store.listAgents();
    console.log(ui.section("Crew", list.length));
    if (!list.length) console.log(`  ${ui.dim("No agents yet. They clock in when you run")} crane serve`);
    for (const a of list) {
      const title = a.taskId ? store.getTask(a.taskId)?.title : undefined;
      const role = a.role ? ` · role: ${MAINTENANCE_ROLE[a.role].label}` : "";
      console.log(`  ${a.active ? "Active" : "On-call"} · default: ${a.defaultDriver ? driverLabel(a.defaultDriver) : "factory default"}${role}`);
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
  });

const crewMember = (member: string) => {
  const a = store.listAgents().find((a) => a.id === member || a.name.toLowerCase() === member.toLowerCase());
  if (!a) throw new Error(`No crew member ${member}`);
  return a;
};

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
      const a = crewMember(member);
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
    } catch (err) { ui.fail((err as Error).message); }
  });

agents
  .command("run <member>")
  .description("Start a crew member's maintenance run on Crane's own repo")
  .action(async (member: string) => {
    try {
      const a = crewMember(member);
      const t = await actions.runRole(a.id);
      ui.ok(`Queued for ${a.name}: ${t.title}  ${ui.dim(`${t.id} · ${AUTONOMY_LABEL[t.autonomy]}`)}`);
      console.log(ui.hint([`crane watch ${t.id}`, "follow along"], [`crane show ${t.id}`, "see the result"]) + "\n");
    } catch (err) { ui.fail((err as Error).message); }
  });

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
      ui.fail((err as Error).message);
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
      ui.fail((err as Error).message);
    }
  });

agents
  .command("postmortem")
  .description("Show or set defaults for all new post-mortems")
  .option("--agent <agent>", "agent name, or default to keep the merged task's agent")
  .option("--model <model>", "model name or alias, or default to follow the agent's settings")
  .option("--effort <level>", "effort level for the chosen agent, or default to follow its settings")
  .action((opts: { agent?: string; model?: string; effort?: string }) => {
    try {
      const change = opts.agent !== undefined || opts.model !== undefined || opts.effort !== undefined;
      const s = change ? actions.configurePostmortem({ driver: opts.agent, model: opts.model, effort: opts.effort }) : actions.postmortemSettings();
      console.log(`  Post-mortems: ${s.driver ? driverLabel(s.driver) : "merged task's agent"} · ${settingsLabel(s) ?? "agent settings"}`);
      if (change) ui.ok("Defaults saved for newly queued post-mortems.");
    } catch (err) { ui.fail((err as Error).message); }
  });

// ── crane analytics: what the factory costs ─────────────────
program
  .command("analytics")
  .alias("spend")
  .description("What the factory spent, by day, agent, repo, type, and task")
  .option("-d, --days <n>", "how many days back, today included", "30")
  .action((opts: { days: string }) => {
    const a = store.analytics(Number(opts.days));
    const span = a.days === 1 ? "today" : `the last ${a.days} days`;
    console.log(`\n${ui.brand()}   Spend, ${span}\n`);
    if (!a.runs) {
      console.log(`  ${ui.dim(`No agent runs finished in ${span}.`)}\n`);
      console.log(ui.hint([`crane analytics --days ${a.days * 3}`, "look further back"]) + "\n");
      return;
    }
    const delta = a.spendUsd - a.prevSpendUsd;
    const before = a.days === 1 ? "day" : `${a.days} days`;
    const vs = ui.dim(
      a.prevSpendUsd === 0
        ? `nothing in the ${before} before`
        : `${delta >= 0 ? "+" : "−"}${ui.usd(Math.abs(delta))} vs the ${before} before`,
    );
    console.log(`  ${pc.bold(ui.usd(a.spendUsd))} spent  ${vs}`);
    const maxDay = Math.max(...a.daily.map((d) => d.usd));
    // Scale to whole numbers first: the sparkline floors its max at 1, which would flatten cents.
    console.log(`  ${ui.sparkline(a.daily.map((d) => (maxDay ? Math.round((d.usd / maxDay) * 100) : 0)))}  ${ui.dim("by day")}`);
    const facts = [
      `${a.runs} runs across ${a.tasks} tasks`,
      a.shipped.tasks ? `${ui.usd(a.shipped.usd / a.shipped.tasks)} per shipped task` : null,
      a.unshipped.usd ? `${ui.usd(a.unshipped.usd)} on work that didn't ship` : null,
    ].filter(Boolean);
    console.log(`  ${ui.dim(facts.join(" · "))}`);
    const t = a.tokens;
    console.log(
      `  ${ui.dim(`${ui.compact(t.input + t.cacheRead + t.cacheWrite)} tokens in (${ui.compact(t.cacheRead)} from cache) · ${ui.compact(t.output)} out`)}`,
    );

    const table = (rows: { label: string; usd: number; tasks: number }[]) => {
      const w = Math.min(32, Math.max(...rows.map((r) => r.label.length)));
      for (const r of rows) {
        console.log(`  ${ui.truncate(r.label, w).padEnd(w)}  ${ui.usd(r.usd).padStart(9)}  ${ui.dim(`${r.tasks} ${r.tasks === 1 ? "task" : "tasks"}`)}`);
      }
    };
    if (a.byAgent.length) {
      console.log(ui.section("By agent"));
      table(a.byAgent.map((r) => ({ label: driverLabel(r.driver), usd: r.usd, tasks: r.tasks })));
    }
    if (a.byRepo.length) {
      console.log(ui.section("By repo"));
      table(a.byRepo.map((r) => ({ label: r.name, usd: r.usd, tasks: r.tasks })));
    }
    if (a.byKind.length) {
      console.log(ui.section("By type"));
      table(a.byKind.map((k) => ({ label: KIND_LABEL[k.kind], usd: k.usd, tasks: k.tasks })));
    }
    if (a.topTasks.length) {
      console.log(ui.section("Most expensive tasks"));
      for (const m of a.topTasks.slice(0, 5)) {
        console.log(`  ${ui.statusDot(m.status)} ${ui.dim(m.id)}  ${ui.truncate(m.title, 44).padEnd(44)}  ${ui.usd(m.usd).padStart(8)}`);
      }
    }
    console.log(
      `\n  ${ui.dim("Costs are what each agent reports, at API prices. On a subscription they're an estimate, not a bill. Codex reports tokens only, so its runs count as $0.")}\n`,
    );
    const next: [string, string][] = [];
    if (a.topTasks[0]) next.push([`crane show ${a.topTasks[0].id}`, "see the most expensive task"]);
    next.push([`crane analytics --days ${a.days === 7 ? 30 : 7}`, `see the last ${a.days === 7 ? 30 : 7} days`]);
    console.log(ui.hint(...next) + "\n");
  });

program
  .command("pause")
  .description("Stop picking up new tasks (current work finishes)")
  .action(() => {
    actions.pause();
    ui.ok("Factory paused. Agents will finish what they're doing, then wait.");
  });

program
  .command("resume")
  .description("Start picking up tasks again")
  .action(() => {
    actions.resume();
    ui.ok("Factory resumed.");
  });

program
  .command("serve")
  .description("Start the factory: agents, API, and dashboard")
  .option("-p, --port <port>", "port for the dashboard", String(DEFAULT_PORT))
  .option(
    "--host <address>",
    "address to listen on. The dashboard has no login, so only use 0.0.0.0 or a LAN address on a network you trust",
    DEFAULT_HOST,
  )
  .option("--agents <n>", "initial active crew size (saved member settings take priority)", process.env.CRANE_AGENTS ?? "2")
  .option(
    "--driver <driver>",
    `default agent: auto | ${DRIVER_NAMES.join(" | ")}. auto keeps the one you chose with crane agents use`,
    process.env.CRANE_DRIVER ?? "auto",
  )
  .option("--no-build-dashboard", "don't build the dashboard from merged changes to Crane; serve web/dist as it is")
  .option("--max-turns <n>", `most turns one agent run may take, 0 for no limit (default ${DEFAULT_MAX_TURNS})`)
  .option("--time-limit <minutes>", `most minutes a task may run, 0 for no limit (default ${DEFAULT_TIME_LIMIT_MIN})`)
  .action(async (opts: { port: string; host: string; agents: string; driver: string; buildDashboard: boolean; maxTurns?: string; timeLimit?: string }) => {
    const num = (v: string | undefined, flag: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) ui.fail(`${flag} takes a number, 0 or more`);
      return n;
    };
    const { serve } = await import("./serve.js");
    await serve(store, {
      port: Number(opts.port),
      host: opts.host,
      agents: Number(opts.agents),
      driver: opts.driver,
      buildDashboard: opts.buildDashboard,
      maxTurns: num(opts.maxTurns, "--max-turns"),
      timeLimit: num(opts.timeLimit, "--time-limit"),
    });
  });

/** Runs one CLI command against `target`. `argv` is shaped like `process.argv`: node, script, then arguments. */
export async function runCli(argv: string[], target: Store): Promise<void> {
  store = target;
  actions = new OperatorActions(store);
  await actions.ensureFactoryRepo();
  await program.parseAsync(argv);
}
