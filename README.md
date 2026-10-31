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

Agents run through [Claude Code](https://code.claude.com) in headless mode, using whatever login your local `claude` CLI already has. If `claude` isn't installed, Crane falls back to **simulated** agents. They walk through believable steps without calling a model, which is handy for trying the UI. It's always labelled as simulated.

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
| `crane cancel <id>` / `crane retry <id>` | Stop work, or run it again |
| `crane repos` / `crane repos add <path>` | The codebases the factory works on |
| `crane agents` | Who's on the crew and what they're doing |
| `crane pause` / `crane resume` | Stop or restart picking up new tasks |
| `crane serve` | Run the factory: agents, API, and dashboard |

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `CRANE_HOME` | `~/.crane` | Where state (SQLite) and worktrees live |
| `CRANE_DRIVER` | `auto` | `claude-code`, `simulated`, or `auto` |
| `CRANE_AGENTS` | `2` | Crew size |
| `CRANE_MODEL` | Claude Code's default | Model passed to `claude --model` |
| `CRANE_ALLOWED_TOOLS` | | Extra Claude Code tool rules, comma-separated |

## How it's built

```
src/
  core/      domain types and the SQLite store (the single source of truth)
  agents/    drivers: Claude Code (headless) and simulated
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
