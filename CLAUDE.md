# Crane

Crane is an autonomous software factory steered by a human operator. Agents run Claude Code headless (`claude -p`) against git repos. This file is read by humans and by Crane's own agents when they work on Crane ("factory feature" tasks).

## Commands

- `npm run dev`: factory on :4471 + UI with hot reload on :5173
- `npm run typecheck`: backend and web
- `npm test`: node:test suites in `test/`
- `npm run build`: compiles `src/` to `dist/` and builds `web/dist/`
- `npx tsx src/cli/index.ts <cmd>`: run the CLI from source
- Demo data: `CRANE_HOME=/tmp/crane-demo npx tsx scripts/seed-demo.ts`, then `serve --driver simulated`

## Shape

- `src/core/store.ts` is the single source of truth (SQLite, WAL). Every process (server, CLI) opens it directly; there is no in-memory state worth trusting across processes. Live views tail the `events` table.
- `src/factory/actions.ts` holds every operator action. The API and CLI both call it, so add new actions there first.
- `src/agents/` holds drivers behind `AgentDriver`. Agents end their final message with a fenced `crane-report` JSON block (`src/agents/prompts.ts`), parsed by `src/agents/report.ts`.
- Tasks with autonomy `propose`/`act` run in a git worktree under `$CRANE_HOME/worktrees/<taskId>` on branch `crane/<slug>-<id>`. Crane never pushes or merges.
- `web/` is React + Vite with no UI library. Its types come straight from `src/core/types.ts`.

## Rules

- Safety first: nothing an agent does may touch the operator's checkout or default branch. Keep `ALWAYS_DENIED` in `src/agents/claude-code.ts` intact.
- Keep the CLI and web UI at feature parity for operator actions.
- UI work must follow `docs/design.md`. Progressive disclosure is the core principle: show the decision first, the details one tap away.
- Copy is sentence case, plain verbs, and names things by what the operator controls. An action keeps its name everywhere ("Approve" → "Approved").
- Run `npm run typecheck && npm test` before finishing.
