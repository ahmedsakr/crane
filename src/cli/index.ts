import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Store } from "../core/store.js";
import {
  AUTONOMY_LABEL,
  DRIVER_NAMES,
  KIND_LABEL,
  RUN_KIND_LABEL,
  choosableDrivers,
  driverLabel,
  lastMergeOutcome,
  type Autonomy,
  type BlockedTool,
  type TaskKind,
  type TaskStatus,
} from "../core/types.js";
import { OperatorActions, toRule } from "../factory/actions.js";
import { ruleLabel } from "../core/permissions.js";
import { draftTask } from "../factory/instruct.js";
import { DEFAULT_MAX_TURNS, DEFAULT_TIME_LIMIT_MIN, factoryDriverName, factoryIsRunning } from "../factory/orchestrator.js";
import { diffForTask } from "../factory/git.js";
import { DEFAULT_PORT } from "../core/paths.js";
import { servedDashboard } from "../core/webbuild.js";
import * as ui from "./ui.js";

const store = new Store();
const actions = new OperatorActions(store);
await actions.ensureFactoryRepo();

const repoName = (id: string | null) => (id ? store.getRepo(id)?.name : undefined);

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
  const dashboard = servedDashboard();
  const o = store.overview({
    running: factoryIsRunning(store),
    paused: store.isPaused(),
    driver: factoryDriverName(store),
    uiOutdated: dashboard?.outdated ?? false,
    uiBuild: dashboard?.id ?? null,
    uiCommit: dashboard?.commit ?? null,
  });
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
  if (o.factory.uiOutdated) next.push(["npm run build", "the dashboard is older than its source; rebuild it"]);
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
  .option("-y, --yes", "skip the confirmation step")
  .action(async (words: string[], opts: { repo?: string; kind?: TaskKind; autonomy?: Autonomy; agent?: string; yes?: boolean }) => {
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
    ].join("\n");
    p.note(summary, "Here's what I understood");

    if (!opts.yes) {
      const next = await p.select({
        message: "Start it?",
        options: [
          { value: "go", label: "Start task" },
          { value: "autonomy", label: "Change how much freedom it has" },
          { value: "kind", label: "Change the type" },
          ...(choosable.length > 1 ? [{ value: "agent", label: "Change the agent" }] : []),
          { value: "stop", label: "Don't start" },
        ],
      });
      if (p.isCancel(next) || next === "stop") return p.cancel("Nothing was created.");
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
    }

    try {
      const m = actions.createTask({ ...draft, driver });
      p.outro(
        `${pc.green("✓")} Task started  ${ui.dim(m.id)}\n   ${ui.dim("follow along:")} crane watch ${m.id}${
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
  .action((opts: { all?: boolean; status?: string; repo?: string }) => {
    const status = opts.status
      ? (opts.status.split(",") as TaskStatus[])
      : opts.all
        ? undefined
        : (["needs_review", "merging", "running", "queued"] as TaskStatus[]);
    const repoId = opts.repo ? store.getRepo(opts.repo)?.id : undefined;
    const list = store.listTasks({ status, repoId, limit: 50 });
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
    console.log(`  ${ui.statusText(m.status)}${ui.dim(on + cost)}`);

    if (m.report) {
      console.log(ui.section("Summary"));
      console.log(ui.wrap(m.report.summary, 2));
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
          `  ${RUN_KIND_LABEL[r.kind].padEnd(18)} ${ui.usd(r.costUsd).padStart(8)}  ${ui.dim(
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
      next.push([`crane watch ${m.id}`, "follow along live"], [`crane cancel ${m.id}`, "stop it"]);
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
        if (!["queued", "running", "merging"].includes(now.status)) {
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
  .action((id: string, n: string) => {
    try {
      const m = actions.followUp(id, Number(n) - 1);
      ui.ok(`Started ${m.id}  ${ui.dim(m.title)}`);
    } catch (err) {
      ui.fail((err as Error).message);
    }
  });

program
  .command("diff")
  .description("Show the changes a task made on its branch")
  .argument("<id>")
  .action(async (id: string) => {
    const m = store.getTask(id) ?? ui.fail(`No task ${id}`);
    const repo = m.repoId ? store.getRepo(m.repoId) : null;
    if (!repo || !m.branch) ui.fail("This task didn't change any code.");
    const merged = m.status === "merged" ? lastMergeOutcome(store.listEvents(m.id))?.commit : null;
    const diff = await diffForTask(repo, m, merged);
    if (!diff) return console.log(ui.dim("No changes."));
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
      console.log(`  ${a.active ? "Active" : "On-call"} · default: ${a.defaultDriver ? driverLabel(a.defaultDriver) : "factory default"}`);
      console.log(ui.agentLine(a, title ? `${title}  ${ui.dim(`on ${driverLabel(a.driver)}`)}` : undefined));
    }
    const catalog = await actions.drivers();
    console.log(ui.section("Runs on"));
    for (const d of catalog) {
      const mark = d.isDefault ? ui.accent("●") : d.available ? pc.dim("○") : pc.dim("·");
      const name = d.label.padEnd(12);
      console.log(`  ${mark} ${d.available ? name : pc.dim(name)} ${ui.dim(d.isDefault ? `default · ${d.hint}` : d.hint)}`);
    }
    console.log("");
    const other = catalog.find((d) => d.available && !d.isDefault && d.name !== "simulated");
    const next: [string, string][] = [];
    if (other) next.push([`crane agents use ${other.name}`, `run new tasks on ${other.label}`]);
    next.push([`crane do --agent <agent> "…"`, "pick the agent for one task"]);
    console.log(ui.hint(...next) + "\n");
  });

agents
  .command("configure <member>")
  .description("Set a crew member's default agent or active/on-call status")
  .option("--agent <agent>", "default agent, or default to follow the factory")
  .option("--active", "activate this member")
  .option("--on-call", "finish current work, then stop taking tasks")
  .action(async (member: string, opts: { agent?: string; active?: boolean; onCall?: boolean }) => {
    try {
      if (opts.active && opts.onCall) throw new Error("Choose --active or --on-call");
      const a = store.listAgents().find((a) => a.id === member || a.name.toLowerCase() === member.toLowerCase());
      if (!a) throw new Error(`No crew member ${member}`);
      await actions.configureCrew(a.id, { defaultDriver: opts.agent, active: opts.active ? true : opts.onCall ? false : undefined });
      ui.ok(`Updated ${a.name}`);
    } catch (err) { ui.fail((err as Error).message); }
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
  .option("--agents <n>", "initial active crew size (saved member settings take priority)", process.env.CRANE_AGENTS ?? "2")
  .option(
    "--driver <driver>",
    `default agent: auto | ${DRIVER_NAMES.join(" | ")}. auto keeps the one you chose with crane agents use`,
    process.env.CRANE_DRIVER ?? "auto",
  )
  .option("--no-build-dashboard", "don't build the dashboard from merged changes to Crane; serve web/dist as it is")
  .option("--max-turns <n>", `most turns one agent run may take, 0 for no limit (default ${DEFAULT_MAX_TURNS})`)
  .option("--time-limit <minutes>", `most minutes a task may run, 0 for no limit (default ${DEFAULT_TIME_LIMIT_MIN})`)
  .action(async (opts: { port: string; agents: string; driver: string; buildDashboard: boolean; maxTurns?: string; timeLimit?: string }) => {
    const num = (v: string | undefined, flag: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) ui.fail(`${flag} takes a number, 0 or more`);
      return n;
    };
    const { serve } = await import("./serve.js");
    await serve(store, {
      port: Number(opts.port),
      agents: Number(opts.agents),
      driver: opts.driver,
      buildDashboard: opts.buildDashboard,
      maxTurns: num(opts.maxTurns, "--max-turns"),
      timeLimit: num(opts.timeLimit, "--time-limit"),
    });
  });

await program.parseAsync(process.argv);
