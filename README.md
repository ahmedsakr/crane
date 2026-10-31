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

Crane never merges into your default branch or pushes on its own. When you **approve** a task that changed code, Crane merges its branch into the default branch for you and pushes it:

- It builds one `Merge branch 'crane/…'` commit on top of the latest default branch, in Crane's own worktree.
- If that conflicts, an agent resolves the conflicts. Crane checks that no conflict markers are left before it commits.
- It pushes as a plain fast-forward and never force-pushes. If someone else pushed in the meantime, Crane starts over from the new tip.
- Your checkout of the default branch is fast-forwarded only when it has no local changes. Otherwise Crane leaves it alone and tells you to pull.
- If anything goes wrong, the task comes back to you with the reason, and nothing is pushed.

Choose **Approve only** (`crane approve <id> --no-merge`) to keep the branch and merge it yourself.

Reports come back as a summary plus **findings**. Turn any finding into its own task with one click (or `crane follow-up <id> <n>`).

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

The Crew page keeps eight members available. Use **Activate** to bring an on-call member into the pool, or **Put on-call** to let them finish current work and stop taking assignments. Each member can have a default agent; task choices and resumed sessions take priority. These preferences survive restarts. From the CLI, use `crane agents configure Hoist --active --agent codex`, `crane agents configure Hoist --on-call`, or `crane agents configure Hoist --agent default` to follow the factory default.

Pick the default on the Crew page or with `crane agents use codex`. Pick another for one task from the instruct sheet's **Agent** chip (it shows once two agents are installed) or with `crane do --agent codex "…"`. A failed task can be run again on another agent. If no agent is installed, Crane falls back to **simulated** agents. They walk through believable steps without calling a model, which is handy for trying the UI. It's always labelled as simulated.

## The CLI

`crane` with no arguments shows the one screen you need: what needs you, what's in flight, and what to do next. Everything else is one command away.

| Command | What it does |
| --- | --- |
| `crane` | Status: what needs you, what's running, suggested next steps |
| `crane do "…"` | Give the factory an instruction. It shows what it understood before starting. |
| `crane tasks` | Open tasks (`--all` for everything) |
| `crane show <id>` | Summary, findings, changed files, and recent activity |
| `crane watch [id]` | Follow a task, or the whole factory, live |
| `crane approve <id>` / `crane decline <id>` | Decide on work that's waiting for you. Approving merges and pushes it (`--no-merge` to approve only). |
| `crane merge <id>` | Merge and push a task you approved only, or one that finished on its own branch |
| `crane diff <id>` | See what a task changed on its branch |
| `crane follow-up <id> <n>` | Turn finding *n* into a task that makes the change |
| `crane cancel <id>` / `crane retry <id>` | Stop work, or run it again (`--agent codex` to switch agents) |
| `crane blocked` | Commands agents were blocked from, added up across tasks |
| `crane allow "<command>" -r <repo>` / `crane keep-blocked …` | Let agents in that repo run it from now on, or keep it blocked and stop asking. `crane disallow` takes an allowed command back. |
| `crane repos` / `crane repos add <path>` | The codebases the factory works on, and the commands allowed in each |
| `crane agents` / `crane agents use <agent>` | Who's on the crew, which agents are installed, and which one new tasks run on |
| `crane analytics` | What the factory spent, by day, repo, type, and task (`--days 7`). `crane show <id> --events` lists a task's runs and their costs. |
| `crane pause` / `crane resume` | Stop or restart picking up new tasks |
| `crane serve` | Run the factory: agents, API, and dashboard |

You can stop or restart `crane serve` at any time, even while agents are working. Running tasks go back in the queue with their worktree and their agent's session, and when the factory starts again each task resumes its session on the agent that started it, even if you've changed the default since. Merges that were under way run again from the start, which is safe to repeat.

When a change to Crane itself is merged, Crane builds the dashboard from that commit in its own directory (`$CRANE_HOME/builds/<sha>`, never your checkout) and serves it, so UI fixes show up without you running `npm run build`. Open pages offer to reload. If you run `npm run build` yourself, your newer `web/dist` is served instead. `crane serve --no-build-dashboard` turns this off.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `CRANE_HOME` | `~/.crane` | Where state (SQLite) and worktrees live |
| `CRANE_DRIVER` | `auto` | Default agent at startup: `claude-code`, `codex`, `simulated`, or `auto` (keeps the one you chose with `crane agents use`, else the first installed) |
| `CRANE_AGENTS` | `2` | Initially active crew members (1–8); saved per-member activation takes priority on later starts |
| `CRANE_MODEL` | Claude Code's default | Model passed to `claude --model` |
| `CRANE_ALLOWED_TOOLS` | | Extra Claude Code tool rules for every repo, comma-separated. Prefer `crane allow`, which is per repo. |
| `CRANE_MAX_TURNS` | `200` | Most turns one agent run may take (`crane serve --max-turns`). `0` for no limit. |
| `CRANE_TIME_LIMIT_MIN` | `90` | Most minutes a task may hold a crew slot (`crane serve --time-limit`). `0` for no limit. |
| `CRANE_RETRY_DELAY_SEC` | `60` | Pause before retrying a run that hit an overloaded or rate-limited API. Crane retries once. |
| `CRANE_CLAUDE_BIN` / `CRANE_CODEX_BIN` | `claude` / `codex` | Where to find each agent's CLI |
| `CRANE_CODEX_MODEL` | Codex's default | Model passed to `codex exec --model` |

When an agent is blocked from a command, the task shows it, and once the same command is blocked in a second task, Home asks whether to allow it for that repo. Crane's deny list (pushing, merging, checking out the default branch, `rm -rf`) always wins and can't be allowed.

## How it's built

```
src/
  core/      domain types and the SQLite store (the single source of truth)
  agents/    drivers: Claude Code (headless), Codex (exec), and simulated
  factory/   orchestrator, git worktrees, operator actions, instruction parsing
  server/    HTTP API + server-sent events
  cli/       the `crane` command
web/         the dashboard (React + Vite)
```

Every process opens the same SQLite database in WAL mode. That's why the CLI works whether or not the factory is running, and why live views just tail the events table.

## Development

```bash
npm run dev        # factory on :4471 with simulated or real agents, UI with hot reload on :5173
npm run typecheck
npm test
```

## License

MIT
