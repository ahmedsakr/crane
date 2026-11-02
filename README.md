# crane

**An autonomous software factory you steer.**

Crane runs a crew of AI agents that maintain and evolve your codebases. You give it instructions in plain words. Agents investigate, research, and make changes on isolated branches. Anything that would change code waits for you.

```
▟ crane   ◉ Factory is running  on claude-code

  12 shipped this week  +4 vs last week
  ▁▁▂▃▅▃▂▁▁▂▄▆█▆▄▂▁▁▁▂▃▂▁▁  activity, last 24h

Needs you  2
  ● t-7k3q9x  Flaky checkout tests: retries have no backoff     api · 4m ago
  ● t-p2d8wn  Upgrade the payments SDK to v5                     api · 1h ago

  › crane show t-7k3q9x         review the top item
  › crane do "…"                give the factory an instruction
```

## What it does

You, the operator, issue **tasks**. There are three kinds:

| Kind | For |
| --- | --- |
| **Maintenance** | Keeping a codebase healthy: flaky tests, bugs, dependency upgrades, security advisories, cleanup. |
| **Repo feature** | Researching or building a new capability into a repo the factory works on. |
| **Factory feature** | Researching or building a new capability into Crane itself. The factory can evolve itself. |

Each task also has an **autonomy level**, which sets how far an agent may go on its own:

| Level | The agent… |
| --- | --- |
| **Investigate only** (`observe`) | Reads, searches, and reports back. Never changes a file. |
| **Change, then ask me** (`propose`) | Works on its own branch in an isolated git worktree, then waits for your review. |
| **Change on a branch** (`act`) | Works on its own branch and finishes without waiting. |

Crane never merges into your default branch or pushes on its own. For UI changes, complete the [visual review checklist](#visual-review-before-approval) before approval or merge. When you **approve** a task that changed code, Crane merges its branch into the default branch for you and pushes it:

- It builds one `Merge branch 'crane/…'` commit on top of the latest default branch, in Crane's own worktree.
- If that conflicts, an agent resolves the conflicts. Crane checks that no conflict markers are left before it commits.
- It pushes as a plain fast-forward and never force-pushes. If someone else pushed in the meantime, Crane starts over from the new tip.
- Your checkout of the default branch is fast-forwarded only when it has no local changes. Otherwise Crane leaves it alone and tells you to pull.
- If anything goes wrong, the task comes back to you with the reason, and nothing is pushed.

Choose **Approve only** (`crane approve <id> --no-merge`) to keep the branch and merge it yourself.

To skip the wait, **Pre-approve** a task from its page while it's queued or running (`crane pre-approve <id> [--message <note>]`). When its run finishes and the repository checks pass, it goes straight to the merge queue instead of to review, and merges exactly as above, provided its acceptance and visual-review gates pass. UI changes still wait for a recorded candidate inspection or explicit operator waiver; pre-approval never waives this requirement. A failed run or check still fails the task, a merge that can't land still comes back to you, and a task with no branch waits for review. **Undo pre-approval** (`crane pre-approve <id> --undo`) works until the run hands the task over. Investigate-only tasks can't be pre-approved, and **Run again** doesn't carry a pre-approval over to the new task.

### Schedule tasks

To start a task later, open **Start time** on the instruct sheet and choose a preset like **Tonight** or **Tomorrow**, or **Pick a time** for a date and time in your browser's timezone. In the CLI, use `crane do "…" --at 2030-06-15T09:00:00-04:00` (an ISO timestamp with `Z` or an explicit timezone offset). Tasks stay queued until that time, then become eligible for the next free agent; prerequisites, crew assignment, and factory pause still apply. Keep the factory running for timely pickup. If it was off at the scheduled time, the task becomes eligible when it starts again. Schedules survive restarts.

You can also pre-approve at creation: open **Merge when it passes** next to **Start time** and turn on **Pre-approve this task**, or add `--pre-approve` to `crane do`. This works for immediate and scheduled tasks that change code, is off by default, and leaves prerequisites and acceptance criteria in force. The CLI confirmation menu also lets you choose whether it merges when it passes.

The task page shows the start time and lets you change it or **Start now**. CLI equivalents are `crane schedule <id> <timestamp>` and `crane schedule <id> now`. Clearing a start time does not waive prerequisites. You can cancel scheduled work like any queued task. **Run again** creates a fresh task eligible immediately, without carrying over the original start time.

### Prerequisites and acceptance criteria

When work depends on another task, or only counts as done when something observable holds, say so as gates rather than in the brief. Open **Prerequisites and acceptance criteria** on the instruct sheet or under **Make this change**, or pass `--after <id>` and `--accept "<criterion>"` (each repeatable) to `crane do` and `crane follow-up`.

- **Prerequisites** are task ids in the same repo. Crane holds the task in the queue until each one has landed: merged, or finished with no branch left to merge. An approved task whose branch was kept hasn't landed. The task page and `crane show` list what it's waiting for. To start it anyway, **Waive prerequisites** (`crane waive <id> -m "<why>"`). That approves a reduced scope: the agent is told the prerequisites' changes may be missing, and to report what still depends on them as unfinished.
- **Acceptance criteria** are given to the agent as conditions to check, and it reports each one as met or not, with evidence. A pre-approved task merges on its own only when its report shows every criterion met. Otherwise it comes to you for review even though its checks passed, and approving it accepts the reduced scope. A run of any freedom level that leaves a criterion unmet waits for your review.

**Run again** keeps both gates but not a waiver.

### Also look for

To have an agent keep an eye out for more than its task, turn on **Also look for** on the instruct sheet or under **Make this change**: **Refactoring**, **Improvements** (latent bugs, error handling, performance), and **Test gaps**. In the CLI, pass `--look-for refactoring,improvements,test_gaps` (repeatable) to `crane do` and `crane follow-up`, or choose **Change what else it looks for** at the confirmation step. These don't widen the task. The agent finishes the brief first and reports what it spots as findings you can turn into follow-ups. It fixes one inside the task only when the fix is small, low-risk, and in code the task already touches, such as a missing test for behaviour it changed. The task page and `crane show` list what the task also looks for, and **Run again** keeps it.

A task's worktree is removed once nothing needs it: after it merges, when you approve only or decline it, and when it fails or is cancelled. If a failed or cancelled task left changes uncommitted, Crane commits them to the task's branch first, so the branch keeps the work. Worktrees left behind by a crash are found and removed too.

After a successful merge, Crane queues a read-only **Post-mortem** task in the same repository. It reviews the original brief, final report, and recorded activity, prioritizing blocked commands and errors, and recommends ways to reduce friction for future tasks. Large histories are bounded and omissions are marked; this is recorded activity rather than the agent's full private conversation. Findings appear through the usual task report and review flow in both the CLI and dashboard. The review uses a fresh session, consumes agent usage, and can be cancelled like any other task. Any active member can run it unless you name who can (see below). It never changes code or permissions automatically, and it does not run for failed merges or **Approve only**.

Reports come back as a summary plus **findings**. **Make this change** opens scheduling choices for a finding: choose the agent, model, and model effort, then queue the follow-up. When the finding comes from a task whose branch hasn't landed yet, the follow-up lists that task as a prerequisite by default, since it may build on those changes; clear it under **Prerequisites and acceptance criteria** to start from the default branch now. `crane follow-up` doesn't add it for you, and says so: pass `--after <id>` to wait. The CLI mirrors it: `crane follow-up <id> <n> --agent codex --model <model> --effort high`. Model and effort overrides apply only to that task; blank fields use the agent's saved settings. Without options, the follow-up keeps the original task's agent and any task overrides. Once queued, the finding shows its follow-up and that task's live status, one tap from opening it; `crane show` lists it under the finding. If the follow-up fails, is cancelled, or is declined, **Make this change** comes back so you can try again.

Tasks that build or change UI are instructed to capture and inspect screenshots, then attach them to their report. The task page shows previews you can open at full size; `crane show <id>` lists captions and local image paths. Crane retains the images separately from the branch, so they survive worktree cleanup. Agents report worktree-relative PNG, JPEG, or WebP paths in `screenshots: [{ "path": ".crane/screenshots/view.png", "caption": "Updated view at 1280 × 800" }]` (up to 12 images, 10 MiB each). If browser tools are unavailable or blocked, including in Codex's sandbox, the agent must explain the missing screenshots and remaining visual validation in its summary. Crane does not bypass those restrictions to capture them.

### Visual review before approval

Passing typecheck, tests, or review and merge checks does not complete visual validation. If capture or inspection is outstanding, the agent must hand off the changed routes, UI states, exact screenshot commands, and required sizes in its report summary. In Codex's sandbox, local servers and browsers are known to be unavailable: defer capture directly without attempting it or seeking a workaround.

Before **Approve and merge**, **Approve only**, or a later **Merge**, the operator records candidate inspection or an explicit waiver using the task page's **Visual review** form or `crane visual-review <id> --commit <full-sha> -m 'reviewed views, sizes and screenshot paths'`. To waive, add `--waive` and supply the reason and unreviewed scope in the message. An ordinary approval note or pre-approval is never a visual waiver. Recording the decision does not itself approve or queue a merge.

Reports classify UI work with `visualReview: { "required": true, "reason": "changed views and remaining review" }`. Only work with an explicit `required: false` classification and no recognizable UI files or screenshots can skip this decision. Missing classification holds automatic merge. The structured task status records the candidate commit and tree, operator decision, timestamp and evidence or waiver note; agent-supplied decisions are ignored. UI tasks with pre-approval wait in review, and the factory rechecks the decision before any push or default-branch update. A decision covers the task's own work, so you make it once: it carries across a clean merge onto a newer default branch, and across conflict resolutions that don't touch UI. Only new commits on the task's branch, or an agent changing UI files while resolving conflicts, require a fresh decision. In the second case Crane hands back that merge as the candidate. Once you decide, it lands that exact merge if it's still up to date with the default branch, without resolving the conflicts again. If the default branch has moved past it, an agent resolves them again, which asks for one more decision if UI files change. Older tasks without structured status also require a decision before approval or merge.

- [ ] In an approved environment, use an isolated checkout of the candidate commit shown in **Visual review** or `crane show <id>` (which can be a merge candidate rather than the branch tip). Build that candidate's UI (`npm run build -w web` for Crane), then run the repository's existing screenshot tool against every changed view and relevant state. Crane's tool boots a demo serving that checkout's `web/dist`; if using `--url` instead, verify the server serves the candidate build and has the needed review data.
- [ ] Capture and open the images at wide **1280x800**, short **1280x600**, and phone **390x844** sizes (plus any sizes required by the task). Inspect clipping, overflow, layout, and the changed behavior; taking a screenshot alone is not inspection.
- [ ] Record the candidate commit, reviewed routes and states, sizes, screenshot paths, and inspection result in the task's approval note or review record. If inspection is waived, explicitly record the operator's waiver, reason, and unreviewed views and sizes. Recheck affected views if Crane asks for a fresh decision.

For example, run these commands in the candidate checkout in the approved environment, replacing `/tasks` and adding interaction steps for the changed states:

```bash
npm run build -w web &&
npm run screenshot -- /tasks --size 1280x800 --out .crane/screenshots/tasks-wide.png &&
npm run screenshot -- /tasks --size 1280x600 --out .crane/screenshots/tasks-short.png &&
npm run screenshot -- /tasks --size 390x844 --out .crane/screenshots/tasks-phone.png
```

For a task waiting for review, `crane approve <id> --message "Visual review complete: candidate <sha>; /tasks; 1280x800, 1280x600, 390x844; images <paths>; no clipping or overflow"` records the review in the task's activity when approving. To waive it, use a note such as `Visual review waived by operator: candidate <sha>; <reason>; unreviewed: <views and sizes>`. Keep screenshot files available at the recorded paths; an approval note does not upload or retain operator-created images automatically. An agent must leave the checklist pending until the operator records completion or a waiver.

## Quick start

```bash
git clone git@github.com:ahmedsakr/crane.git && cd crane
npm install
npm run build
npm link            # puts `crane` on your PATH

crane repos add ~/code/my-app
crane serve         # starts the agents and the dashboard at http://localhost:4471
crane do "investigate why the checkout tests are flaky in my-app"
```

Agents run through a coding agent CLI you already have, using its existing login:

- [Claude Code](https://code.claude.com), headless (`claude -p`).
- [Codex](https://github.com/openai/codex), non-interactive (`codex exec`). Investigate-only tasks run in Codex's read-only sandbox. Everything else runs in its workspace sandbox with the network off, confined to the task's worktree, so Codex can't commit, push, or touch your checkout. Crane commits what it leaves. Codex reports tokens but not cost, so its runs count as $0 in analytics.

The Crew page keeps eight members available, split into active and on-call, and flags queued work when no one is free to take it. Use **Activate** on an on-call member's row to bring them into the pool. Tap a member's row to open their sheet, where **Put on-call** lets them finish current work and stop taking assignments. Each member can have a default agent, also in their sheet; task choices and resumed sessions take priority. These preferences survive restarts. From the CLI, use `crane agents configure Hoist --active --agent codex`, `crane agents configure Hoist --on-call`, or `crane agents configure Hoist --agent default` to follow the factory default.

Pick the default on the Crew page or with `crane agents use codex`. Pick another for one task from the instruct sheet's **Agent** chip (it shows once two agents are installed) or with `crane do --agent codex "…"`. A failed task can be run again on another agent.

Each agent can run on a model and effort level you choose: tap its row in **Runs on** on the Crew page, or `crane agents set claude-code --model opus --effort high`. Claude Code takes `--effort` low, medium, high, xhigh, or max; Codex takes `model_reasoning_effort` minimal, low, medium, high, or xhigh. Use `default` (or clear the field) to go back to the agent's own. Changes apply from each agent's next run, including resumed ones, without a restart. The model a run actually used shows in its activity feed and in analytics.

Set separate defaults for the read-only reviews queued after every merge under **Post-mortems** on the Crew page, or with `crane agents postmortem --agent claude-code --model sonnet --effort low`. Run `crane agents postmortem` to see them. These choices are saved when each post-mortem is queued; existing tasks keep their choices. Clear model or effort (or use `default`) to follow that agent's settings. `--agent default` clears the overrides and restores the merged task's agent. Changing agents clears the previous model and effort unless you supply replacements.

Choose who runs post-mortems under **Who can run them** in the same section, or with `crane agents postmortem --crew hoist,boom`. Once you name anyone, only they run post-mortems. A named on-call member comes in for post-mortems while staying on-call for everything else, so each one adds to the work running at once. A named member with a maintenance role takes them as well as their own runs. This applies right away, including to post-mortems already waiting, and `--crew default` (or ticking no one) goes back to any active member.

If no agent is installed, Crane falls back to **simulated** agents. They walk through believable steps without calling a model, which is handy for trying the UI. It's always labelled as simulated.

### Maintenance roles

A crew member can be dedicated to one kind of upkeep on a connected repo: **Code quality**, **Duplication**, **Packaging** (module boundaries, and parts that could be shared as packages), **Best practices**, **Security review**, or **Tests**. Pick it from **Maintenance role** in the member's sheet on the Crew page, then start a run from the button on their row, or with `crane agents configure Hoist --role security` (`--role none` makes them a general member again; `crane agents roles` lists them all). A member with a role stops taking queued tasks and works only the runs you start for them, though they still help land approved merges.

Start a run with the button on their row (**Review security**, **Reduce duplication**, …), choose a repository and start time, then select **Start run** or **Schedule run**. Crane's own repo is the default. In the CLI, use `crane agents run hoist`, or `crane agents run hoist --repo my-app --at 2030-06-15T09:00:00-04:00` to schedule a run on another connected repo (name or id). It queues a maintenance task that only that member picks up, with a brief for their role. Packaging and security reviews investigate only, so turn the findings you want into follow-ups; the others make a change on a branch and wait for your review. A member has one queued or running run per repo at a time, including future runs, and must be active to start one. Runs in different repos wait for that member to be free.

## The CLI

`crane` with no arguments shows the one screen you need: what needs you, what's in flight, and what to do next. Everything else is one command away.

| Command | What it does |
| --- | --- |
| `crane` | Status: what needs you, what's running, suggested next steps |
| `crane do "…"` | Give the factory an instruction. It shows what it understood before starting. |
| `crane tasks` | Open tasks (`--all` for everything, `--json` for full records including each task's branch and worktree) |
| `crane show <id>` | Summary, findings, changed files, and recent activity |
| `crane watch [id]` | Follow a task, or the whole factory, live |
| `crane approve <id>` / `crane decline <id>` | Decide on work that's waiting for you. Approving merges and pushes it (`--no-merge` to approve only). |
| `crane pre-approve <id>` | Approve a queued or running task ahead of time, so it merges once its checks pass (`--undo` to take it back) |
| `crane merge <id>` | Merge and push a task you approved only, or one that finished on its own branch |
| `crane diff <id>` | See what a task changed on its branch, or its changes so far, uncommitted work included, while it runs. `--files` lists the files with lines added and removed; `--file <path>` shows one file |
| `crane follow-up <id> <n> [--agent <agent>] [--model <model>] [--effort <level>] [--after <id>] [--accept "<criterion>"] [--look-for <what>]` | Turn finding *n* into a task with optional agent, model, and effort choices, prerequisites, acceptance criteria, and what else to look out for |
| `crane waive <id>` | Start a queued task without the prerequisites that haven't landed, approving a reduced scope |
| `crane cancel <id>` / `crane retry <id>` | Stop work, or run it again (`--agent codex` to switch agents) |
| `crane blocked` | Commands agents were blocked from, added up across tasks |
| `crane allow "<command>" -r <repo>` / `crane keep-blocked …` | Let agents in that repo run it from now on, or keep it blocked and stop asking. `crane disallow` takes an allowed command back. |
| `crane repos` / `crane repos add <path>` | The codebases the factory works on, and the commands allowed in each |
| `crane agents` / `crane agents use <agent>` | Who's on the crew, which agents are installed, and which one new tasks run on |
| `crane agents set <agent> --model <model> --effort <level>` | Choose the model and effort an agent runs with (`default` for its own) |
| `crane agents postmortem [--agent <agent>] [--model <model>] [--effort <level>] [--crew <members>]` | Show or set who runs post-mortems and the defaults for newly queued ones |
| `crane agents run <member> [--repo <repo>] [--at <timestamp>]` | Start or schedule a member's maintenance run; repo defaults to Crane (`crane agents configure <member> --role <role>` to give them one) |
| `crane analytics` | What the factory spent, by day, repo, type, and task (`--days 7`). `crane show <id> --events` lists a task's runs and their costs. |
| `crane pause` / `crane resume` | Stop or restart picking up new tasks |
| `crane serve` | Run the factory: agents, API, and dashboard |

You can stop or restart `crane serve` at any time, even while agents are working. Running tasks go back in the queue with their worktree and their agent's session, and when the factory starts again each task resumes its session on the agent that started it, even if you've changed the default since. Merges that were under way run again from the start, which is safe to repeat.

For Codex commands, Crane persists correlated start and completion records in task events, including the session, command, status, and received exit code. Commands without a received completion become interrupted or unknown; this does not prove they failed or stopped. Resumed and replacement sessions receive up to 40 recent command records within a 32,000-character prompt budget. Each command is limited to 8,192 characters with a truncation flag; stdout and stderr are not retained. Common credential arguments, environment assignments, authentication headers, URL credentials and query strings are redacted before storage, but arbitrary secrets embedded in scripts or unnamed positional arguments cannot be reliably recognized: avoid putting credentials in command text. These records are agent evidence and do not replace Crane's external review or merge checks. Older events that recorded only starts cannot establish a command's outcome.

The dashboard has no login, so `crane serve` listens on `127.0.0.1` only, answers only to `localhost`, `127.0.0.1` and `[::1]`, and refuses changes sent from any other origin. To reach it from another machine, pass `--host 0.0.0.0` (or a LAN address) on a network you trust: anyone who can reach it can approve and merge tasks.

When a change to Crane itself is merged, Crane builds the dashboard from that commit in its own directory (`$CRANE_HOME/builds/<sha>`, never your checkout) and serves it, so UI fixes show up without you running `npm run build`. Open pages offer to reload. If you run `npm run build -w web` yourself, your newer `web/dist` is served instead. `crane serve --no-build-dashboard` turns this off.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `CRANE_HOME` | `~/.crane` | Where state (SQLite) and worktrees live |
| `CRANE_DRIVER` | `auto` | Default agent at startup: `claude-code`, `codex`, `simulated`, or `auto` (keeps the one you chose with `crane agents use`, else the first installed) |
| `CRANE_AGENTS` | `2` | Initially active crew members (1–8); saved per-member activation takes priority on later starts |
| `CRANE_MODEL` | Claude Code's default | Model passed to `claude --model` when none is set with `crane agents set` |
| `CRANE_ALLOWED_TOOLS` | | Extra Claude Code tool rules for every repo, comma-separated. Prefer `crane allow`, which is per repo. |
| `CRANE_MAX_TURNS` | `200` | Most turns one agent run may take (`crane serve --max-turns`). `0` for no limit. |
| `CRANE_TIME_LIMIT_MIN` | `90` | Most minutes a task may hold a crew slot (`crane serve --time-limit`). `0` for no limit. |
| `CRANE_RETRY_DELAY_SEC` | `60` | Pause before retrying a run that hit an overloaded or rate-limited API. Crane retries once. |
| `CRANE_CLAUDE_BIN` / `CRANE_CODEX_BIN` | `claude` / `codex` | Where to find each agent's CLI |
| `CRANE_CODEX_MODEL` | Codex's default | Model passed to `codex exec --model` when none is set with `crane agents set` |

When an agent is blocked from a command, the task shows it, and once the same command is blocked in a second task, Home asks whether to allow it for that repo. Crane's deny list (pushing, merging, checking out the default branch, `rm -rf`) always wins and can't be allowed.

## How it's built

```
src/
  core/      domain types and the SQLite store (the single source of truth)
  factory/   orchestrator, git worktrees, operator actions, instruction parsing
  server/    HTTP API + server-sent events
  cli/       the `crane` command
web/         the dashboard (React + Vite)
packages/
  contracts/       shared types, labels, helpers, and rule grammar
  agent-protocol/  factory/driver interface, reports, and combined costs
  agent-policy/    deny list and shared permission-rule handling
  agent-drivers/   concrete drivers, prompts, CLI helpers, and provider pricing
  worktree-deps/   lockfile-based dependency installation and verified copies
```

Every process opens the same SQLite database in WAL mode. That's why the CLI works whether or not the factory is running, and why live views just tail the events table.

## Development

```bash
npm run dev        # factory on :4471 with simulated or real agents, UI with hot reload on :5173
npm run typecheck
npm test
```

`npm run build` transpiles `src/` to `dist/` with esbuild and doesn't check
backend types, so run `npm run typecheck` to catch type errors. `prepack` runs it
before packing. `scripts/build.mjs` runs the `build:packages`, `build:backend`,
and web `build` scripts without starting npm for each one.

The private workspaces compile to ESM and declarations before build, typecheck,
tests, dev, and the source CLI. `npm run build:packages` checks workspace links,
then runs `tsc -b tsconfig.packages.json` to build packages in dependency order;
run it before invoking source scripts directly. Each package is composite and
references its workspace dependencies. Keep the solution's references in sync
with `packages/*`; package boundary tests check both lists. Build caches live
inside each package's `dist/`, so deleting that directory also clears its cache.
`npm run dev` uses one `tsc -b` watcher for the package graph. Import policy helpers from
`@crane/agent-policy`; its only runtime dependency is `@crane/contracts/rules`,
and its command splitter stays internal. Import concrete drivers from
`@crane/agent-drivers`; prompts, CLI helpers, command-evidence tracking, and
provider pricing stay private. Only `src/factory/drivers.ts` loads the drivers
in production. The root npm tarball bundles all private workspace
packages for installed CLI use without separate registry releases. Changes to
package inputs mark the running factory as outdated; rebuild and
restart it to load them.

For Codex's restricted agent sandbox, use the documented
[sandbox test selection](docs/testing.md#sandbox-test-selection) and leave known
incompatible suites to Crane's full external review and merge checks.

## License

MIT
# Repository validation

Use **Repos → Checks** to configure shell commands, one per line, for each
repository. These are trusted operator commands executed by the factory in its
isolated worktree, not commands supplied by an agent. Crane defaults to
`npm run typecheck` and `npm test` for its own repository. Other repositories
start unconfigured and cannot pass review or merge gates until checks are set.
The local API also supports `GET /api/repos/:id/checks` and
`PUT /api/repos/:id/checks` (a JSON array of command strings).

After committing agent changes, Crane runs checks before marking work ready.
After explicit operator merge approval, it checks the actual merge commit
before pushing or updating the local default branch. Conflict resolutions and
remote-moved retries each receive fresh checks. No previous passing result is
reused for a different commit.

Task reports retain factory-owned evidence for every check: phase, command,
commit SHA, exit code, logs, and duration. The task view exposes this evidence.
Nonzero exits are **failed**; execution errors, cancellation, timeouts, and
output limits are **blocked**; missing commands are **unconfigured**. All stop
the gate. Each command has a ten-minute limit and a 16 MiB captured-output
limit. Checks must leave the commit and tracked files unchanged.

