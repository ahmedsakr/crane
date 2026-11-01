# Crane

Crane is an autonomous software factory steered by a human operator. Agents run Claude Code headless (`claude -p`) against git repos. This file is read by humans and by Crane's own agents when they work on Crane ("factory feature" tasks).

## Commands

- `npm run dev`: factory on :4471 + UI with hot reload on :5173
- `npm run typecheck`: backend, tests, scripts, and web
- `npm test`: node:test suites in `test/`
- `npm run build`: compiles `src/` to `dist/` and builds `web/dist/`
- `npx tsx src/cli/index.ts <cmd>`: run the CLI from source
- Demo data: `CRANE_HOME=/tmp/crane-demo npx tsx scripts/seed-demo.ts`, then `serve --driver simulated`
- `npm run screenshot -- <path> [steps] --out <file.png>`: boots a throwaway demo factory and screenshots the built UI in headless Chromium. Steps run in order: `--click <sel>`, `--type <text>`, `--key Escape`, `--wait-for <sel>`, `--eval <js>`, `--shot <file>`, `--size 390x844`. Run `npm run build -w web` first. Example: `npm run screenshot -- "/?instruct=Fix the tests" --click ".choice-btn" --out .crane/menu.png`

## Shape

- `src/core/store.ts` is the single source of truth (SQLite, WAL). Every process (server, CLI) opens it directly; there is no in-memory state worth trusting across processes. Live views tail the `events` table.
- `src/factory/actions.ts` holds every operator action. The API and CLI both call it, so add new actions there first.
- `src/agent-protocol/` is what the factory and every driver agree on: `AgentDriver`, `RunContext`, `AgentRunError` (one class; retries check `instanceof`), `isTransientFailure`, `REPORT_FENCE`, `parseReport` and `combinedCost`. It will become the `@crane/agent-protocol` package, so it imports only contract types, and everything else imports it through `index.ts`. `src/agents/driver.ts`, `report.ts` and `combinedCost` in `codex-pricing.ts` are temporary re-exports; don't add new imports of them.
- `src/agents/` holds drivers behind `AgentDriver`: Claude Code, Codex, simulated. `src/factory/drivers.ts` is the registry. A task's `driver` is the operator's pick (null follows the default setting); an interrupted task resumes on the driver of its last work run, which owns its session. Adding an agent means a driver, an entry in `DRIVER_NAMES` (`src/core/types.ts`), and one in `createDriver`. Agents end their final message with a fenced `crane-report` JSON block (asked for in `src/agents/prompts.ts`), parsed by `src/agent-protocol/report.ts`, which owns the fence tag and ignores agent-supplied `validation`. Drivers never import `src/factory/`: plain git calls go through `src/core/git.ts`, and Crane's worktree and branch logic stays in `src/factory/git.ts`. Only the registry imports concrete drivers (`test/boundaries.test.ts` checks both).
- Tasks with autonomy `propose`/`act` run in a git worktree under `$CRANE_HOME/worktrees/<taskId>` on branch `crane/<slug>-<id>`. Crane never pushes or merges on its own. Only an operator's Approve (or Merge) does, and then Crane's own code in `src/factory/merge.ts` lands the branch (merge commit, fast-forward push, local default branch moved only when its checkout is clean). Agents only ever resolve conflicts inside Crane's worktree; they never push or merge.
- `web/` is React + Vite with no UI library. It imports backend source only through `src/core/contracts.ts` (domain types, API response shapes like `TaskDetail`, labels), which must stay browser-safe: no Store, `node:` modules, or packages. The server types its responses with the same contracts.

## Rules

- Safety first: nothing an agent does may touch the operator's checkout or default branch. Keep `ALWAYS_DENIED` in `src/agents/policy.ts` intact. Codex has no deny list, so its guard is the sandbox in `codexArgs` (`src/agents/codex.ts`): read-only for investigate-only, workspace-write with no network and no extra writable roots otherwise. Never loosen it. Every new driver needs an equivalent guard. The one place Crane moves a default branch is `landTask` in `src/factory/merge.ts`, after the operator approves: never force-push, and never touch a checkout that has local changes.
- Keep the CLI and web UI at feature parity for operator actions.
- UI work must follow `docs/design.md`. Progressive disclosure is the core principle: show the decision first, the details one tap away.
- Look at UI changes before calling them done. Take screenshots with `npm run screenshot` (wide, short, and phone sizes) and read the PNGs; for visual bugs, reproduce in a screenshot first. A clean typecheck says nothing about clipping or layout.
- The dashboard on :4471 serves whichever build is newest: Crane's own build of the latest merge to its repo (`$CRANE_HOME/builds/<sha>`, made by `src/factory/dashboard.ts` after each factory-repo merge and on `crane serve`), or the checkout's `web/dist`. If the operator reports that a fixed UI bug is still there, check which build is served (`uiCommit` in `/api/overview`), whether that build failed (a note on the merged task), and whether their tab needs a reload.
- Backend changes need a separate rebuild and restart when `bin/crane.js` runs `dist/`. `/api/overview` reports `factory.factoryOutdated`, and the dashboard shows a notice when the running build is older than its checkout's `src/`. The notice stays until restart even if someone rebuilds on disk. Dashboard builds and page reloads do not update the running backend.
- Copy is sentence case, plain verbs, and names things by what the operator controls. An action keeps its name everywhere ("Approve" → "Approved").
- Run `npm run typecheck && npm test` before finishing.
- Codex agents work in a sandbox whose no-network filter also refuses `listen` and some calls on local sockets, which Node uses for piped child stdio. Write tests that still run there: spawn with `stdio: ["ignore", "pipe", "pipe"]` (an `execFileSync` with a stdin pipe fails with `spawnSync <cmd> EPERM`), and use `node:fs` instead of shelling out. Under Codex, `npm test` shows only per-file results, so run one file directly (`node --import tsx test/<file>.test.ts`) to see which test failed. Tests that start a fake agent CLI over piped stdio, and `npm run screenshot`, can't run there: report them as not run rather than reshaping tests or code to get around the sandbox.
