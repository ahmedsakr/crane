# Crane

Crane is an autonomous software factory steered by a human operator. Agents run Claude Code headless (`claude -p`) against git repos. This file is read by humans and by Crane's own agents when they work on Crane ("factory feature" tasks).

## Commands

- `npm run dev`: factory on :4471 + UI with hot reload on :5173
- `npm run typecheck`: backend and web
- `npm test`: node:test suites in `test/`
- `npm run build`: compiles `src/` to `dist/` and builds `web/dist/`
- `npx tsx src/cli/index.ts <cmd>`: run the CLI from source
- Demo data: `CRANE_HOME=/tmp/crane-demo npx tsx scripts/seed-demo.ts`, then `serve --driver simulated`
- `npm run screenshot -- <path> [steps] --out <file.png>`: boots a throwaway demo factory and screenshots the built UI in headless Chromium. Steps run in order: `--click <sel>`, `--type <text>`, `--key Escape`, `--wait-for <sel>`, `--eval <js>`, `--shot <file>`, `--size 390x844`. Run `npm run build -w web` first. Example: `npm run screenshot -- "/?instruct=Fix the tests" --click ".choice-btn" --out .crane/menu.png`

## Shape

- `src/core/store.ts` is the single source of truth (SQLite, WAL). Every process (server, CLI) opens it directly; there is no in-memory state worth trusting across processes. Live views tail the `events` table.
- `src/factory/actions.ts` holds every operator action. The API and CLI both call it, so add new actions there first.
- `src/agents/` holds drivers behind `AgentDriver`. Agents end their final message with a fenced `crane-report` JSON block (`src/agents/prompts.ts`), parsed by `src/agents/report.ts`.
- Tasks with autonomy `propose`/`act` run in a git worktree under `$CRANE_HOME/worktrees/<taskId>` on branch `crane/<slug>-<id>`. Crane never pushes or merges on its own. Only an operator's Approve (or Merge) does, and then Crane's own code in `src/factory/merge.ts` lands the branch (merge commit, fast-forward push, local default branch moved only when its checkout is clean). Agents only ever resolve conflicts inside Crane's worktree; they never push or merge.
- `web/` is React + Vite with no UI library. Its types come straight from `src/core/types.ts`.

## Rules

- Safety first: nothing an agent does may touch the operator's checkout or default branch. Keep `ALWAYS_DENIED` in `src/agents/claude-code.ts` intact. The one place Crane moves a default branch is `landTask` in `src/factory/merge.ts`, after the operator approves: never force-push, and never touch a checkout that has local changes.
- Keep the CLI and web UI at feature parity for operator actions.
- UI work must follow `docs/design.md`. Progressive disclosure is the core principle: show the decision first, the details one tap away.
- Look at UI changes before calling them done. Take screenshots with `npm run screenshot` (wide, short, and phone sizes) and read the PNGs; for visual bugs, reproduce in a screenshot first. A clean typecheck says nothing about clipping or layout.
- The dashboard on :4471 serves whichever build is newest: Crane's own build of the latest merge to its repo (`$CRANE_HOME/builds/<sha>`, made by `src/factory/dashboard.ts` after each factory-repo merge and on `crane serve`), or the checkout's `web/dist`. If the operator reports that a fixed UI bug is still there, check which build is served (`uiCommit` in `/api/overview`), whether that build failed (a note on the merged task), and whether their tab needs a reload.
- Copy is sentence case, plain verbs, and names things by what the operator controls. An action keeps its name everywhere ("Approve" → "Approved").
- Run `npm run typecheck && npm test` before finishing.
