# Backend extraction contract and baseline

Status: **contract and baseline recorded**, 2026-11-09, at commit `c41f6db`
(`main` at `2b34e48` plus the benchmark script). Runtime, storage and factory extraction are implemented in `packages/backend-runtime`, `packages/storage` and `packages/factory`; HTTP extraction is pending.
This document is the contract the extraction tasks follow and the baseline
they are measured against. Change it together with the extraction that
changes the facts.

Why: today `backend` (`src/`) is one Nx project that depends on all six
packages and is compiled by one `tsc -p tsconfig.json`. Any edit under `src/`
type-checks the whole backend and selects the same 106 root suites. Splitting
`src/` into dependency-directed packages lets Nx and test ownership skip the
parts an edit can't reach. Extraction alone doesn't make tests faster: the
selection only narrows once test ownership (task t-sz4q53) and checks
compilation (task t-t2ur89) are partitioned along the new boundaries. See
[Measured baseline](#measured-baseline) for what an edit costs today.

## Package graph

Four new workspaces under `packages/`, each named `@crane/<dir>` as
`test/contracts.test.ts` requires, plus the existing application:

```
@crane/contracts
  └─ @crane/backend-runtime
       └─ @crane/storage
            └─ @crane/factory ── also: agent-drivers, agent-policy, agent-protocol,
                 │                     diagnostics, worktree-deps
                 └─ @crane/http-server
                      └─ backend (src/cli)
@crane/web ── contracts only, unchanged
```

| Project | Root | Direct `@crane/*` dependencies | Third-party dependencies |
| --- | --- | --- | --- |
| `@crane/backend-runtime` | `packages/backend-runtime` | contracts | Node only |
| `@crane/storage` | `packages/storage` | backend-runtime, contracts | `better-sqlite3` |
| `@crane/factory` | `packages/factory` | storage, backend-runtime, contracts, agent-drivers, agent-policy, agent-protocol, diagnostics, worktree-deps | Node only |
| `@crane/http-server` | `packages/http-server` | factory, storage, backend-runtime, contracts | `hono` |
| `backend` | `src` (only `src/cli/`) | every `@crane/*` package (the root manifest's dependencies, which `test/contracts.test.ts` requires to list every package) | `commander`, `@clack/prompts`, `picocolors`, `@hono/node-server`, `better-sqlite3` (only `crane setup`'s probe) |

Edges are exactly what the current imports need, and the graph is acyclic.
Measured over today's `src/` with `test/support/imports.ts`'s `moduleRefs`
(every import form, including `import type` and dynamic imports), the
cross-layer imports run only downward:

| From → to | Imports | Notes |
| --- | --- | --- |
| storage → runtime | 8 | `paths`, `ids`, `actor` |
| factory → runtime | 18 | |
| factory → storage | 29 | 25 type-only; values: `Store` (`actions/crew.ts`, `orchestrator.ts`), `retainScreenshots`, `StorageMaintenance` |
| http-server → runtime | 2 | `actor`, `webbuild` |
| http-server → storage | 4 | 3 type-only; `readScreenshot` |
| http-server → factory | 10 | |
| cli → runtime | 6 | |
| cli → storage | 12 | `Store` (dynamic in `index.ts`), `screenshotPath`; the rest type-only |
| cli → factory | 16 | |
| cli → http-server | 3 | |

Nothing imports upward (runtime → anything in `src/`, storage → factory or
server, factory → server or CLI): there were zero such edges, so no extraction
needs a new interface to break a cycle. Within `src/` the only `@crane/*`
imports are contracts (runtime, storage, server, CLI), agent-protocol (CLI:
the `AgentDriver` type in `cli/serve.ts`) and all six packages (factory). The
CLI's package edges are the root manifest's, as today.

Keeping every `src/factory/` module together, including `OperatorActions`,
avoids inventing an actions-to-orchestrator contract in this change. The
factory package is the largest (44 modules) and the one most edits touch; a
later split there needs its own measurement.

## Module ownership

Every module in `src/` today (124 `.ts` files, plus `src/project.json`) has
exactly one owner. Paths are relative to `src/`; each becomes
`packages/<package>/src/<same relative path below the old directory>` unless the
extraction task records otherwise.

### `@crane/backend-runtime` (5)

- `core/`: `paths`, `actor`, `ids`, `git`, `webbuild`

Paths, the actor context, ids and slugs, the `git` exec helper, and build
identity (`createFactoryBuildCheck`, `servedDashboard`, `webBuildOutdated`,
`dashboardBuilds`, `BUILD_MANIFEST`).

### `@crane/storage` (25)

- `core/`: `store`, `postmortem`, `screenshots`, `retention`
- `core/store/` (21): `access`, `analytics`, `blocked-tools`, `claims`,
  `crew`, `crew-schedules`, `events`, `goal-progress`, `goals`, `migrations`,
  `overview`, `prerequisites`, `queue`, `repos`, `review`, `rows`, `runs`,
  `schema`, `settings`, `shared`, `tasks`

`postmortem` stays here because `store/review.ts` builds the post-mortem brief
from it; `screenshots` and `retention` own on-disk data under `$CRANE_HOME`.
The rule that only the store touches `store.db` and better-sqlite3 (with
`crane setup`'s probe as the one exception) moves with it.

### `@crane/factory` (44)

- `factory/` (30): `action-inputs`, `actions`, `agent-logs`, `agent-runner`,
  `auth-crypto`, `checks`, `dashboard`, `driver-selection`, `drivers`,
  `elapsed`, `git`, `goals`, `instruct`, `merge`, `merge-conflicts`,
  `merge-fetch`, `merge-fixes`, `merge-git`, `merge-request`, `merge-run`,
  `orchestrator`, `review-checkpoint`, `run-limits`, `settings`, `state`,
  `storage-diagnostics`, `task-context`, `visual-review`, `work-run`,
  `worktree-sweeper`
- `factory/actions/` (14): `access`, `access-errors`, `access-invites`,
  `access-rules`, `access-sessions`, `crew`, `drivers`, `goals`,
  `permissions`, `repos`, `review`, `schedules`, `settings`, `tasks`

`storage-diagnostics` stays here despite its name: only `checks.ts` uses it,
and it diagnoses check workspaces, not the store. `drivers.ts` remains the
only production importer of `@crane/agent-drivers`.

### `@crane/http-server` (16)

- `server/` (6): `app`, `auth`, `body`, `security`, `sign-in-limit`, `static`
- `server/routes/` (10): `auth`, `crew`, `deps`, `factory`, `goals`,
  `operators`, `overview`, `repos`, `task-decisions`, `tasks`

The Node listener (`@hono/node-server`, TLS and address handling) stays in the
CLI's `serve.ts`, so the package exports a Hono app and its security checks,
not a running server.

### `backend` application (34)

- `cli/` (8): `context`, `index`, `program`, `serve`, `setup`, `start`, `tls`, `ui`
- `cli/commands/` (26): `access-shared`, `agents`, `analytics`, `auth`,
  `change-agent`, `command-access`, `crew-schedules`, `decisions`, `diff`,
  `do`, `factory-control`, `follow-ups`, `goals`, `home`, `next-steps`,
  `operators`, `permissions`, `queue`, `repos`, `retention`, `schedule`,
  `serve`, `shared`, `show`, `tasks`, `watch`
- `project.json` stays, with `backend`'s targets narrowed to `src/cli`.

## Public exports

Each package exports one ESM entry point (`./dist/index.js` with
declarations) unless an extraction records a subpath. The minimum surface is
what production code outside the package imports today:

| Package | Module today | Names other layers import |
| --- | --- | --- |
| backend-runtime | `core/paths` | `craneHome`, `dbPath`, `worktreesDir`, `buildsDir`, `DEFAULT_HOST`, `DEFAULT_PORT` |
| | `core/actor` | `withActor`, `hostActor`, `actorSnapshot` |
| | `core/ids` | `shortId`, `slugify` |
| | `core/git` | `git` |
| | `core/webbuild` | `factoryBuildOutdated`, `servedDashboard`, `webBuildOutdated`, `dashboardBuilds`, `BUILD_MANIFEST` |
| storage | `core/store` | `Store`, `LandedCommit`, `crewSettingKey` |
| | `core/store/access` | types `InviteRecord`, `LiveWindow`, `NewInvite`, `OperatorRecord`, `SessionListing`, `SessionRecord` |
| | `core/store/tasks` | types `NewTaskRecord`, `StatusTransition` |
| | `core/screenshots` | `screenshotPath`, `readScreenshot`, `retainScreenshots` |
| | `core/retention` | `StorageMaintenance` |
| factory | `factory/actions` | `OperatorActions`, `AccessError`, `Authenticated`, `IssuedInvite`, `SESSION_LIFETIME_MS`, `SIGN_IN_FIRST`, `WRONG_CURRENT_PASSWORD`, `checkLookouts`, `checkScheduledAt`, `toRule` |
| | `factory/orchestrator` | `Factory` |
| | `factory/drivers` | `isAvailable`, `resolveDefaultDriver`, `sharedDrivers` |
| | `factory/state` | `factoryState`, `factoryIsRunning`, `factoryDriverName` |
| | `factory/settings` | `DEFAULT_DRIVER_KEY`, `DEFAULT_MAX_TURNS`, `DEFAULT_TIME_LIMIT_MIN` |
| | `factory/git` | `diffForTask` |
| | `factory/instruct` | `draftTask` |
| http-server | `server/app` | `createApp`, `AppOptions` |
| | `server/security` | `checkExposure`, `ExposureCheck` |

Everything else stays private. `postmortem`, the `store/` domain modules and
the factory's run services are not exported.

Root suites reach far more than this: 77 of the 119 suites (224 import lines),
plus `test/support/auth-e2e.ts` and `test/support/api-client.ts`, import
`src/` modules directly, across every layer. As with `@crane/agent-drivers`,
repository tests may keep importing package source paths
(`../packages/<dir>/src/...`); production code, `scripts/` and `web/` use
entry points only (`test/contracts.test.ts`). One exception matters: modules
with process-wide state (`actor`'s `AsyncLocalStorage`, `webbuild`'s caches
and `factoryBuildOutdated`) must be loaded once. A test that imports
`packages/backend-runtime/src/actor.ts` while the code under test imports
`@crane/backend-runtime` gets two `AsyncLocalStorage` instances, and actor
stamping silently stops matching. Tests that set or read the actor, or the
build-identity caches, import them through the package entry point.

## CLI bootstrap and application identity

The application stays a CLI that the extracted packages never import. These
must hold after every extraction:

1. **Entry.** `bin/crane.js` loads `dist/cli/index.js` when it exists and
   otherwise registers tsx and loads `src/cli/index.ts`. Package `dist/` must
   be built first in both cases (`build:packages`, which `npm run crane`,
   `build`, `typecheck`, `test` and `dev` already run).
2. **Setup before storage.** `crane setup` must work when better-sqlite3's
   native binding is broken. `src/cli/index.ts` imports `setup` before, and
   instead of, the store. `@crane/storage`'s entry point loads better-sqlite3
   at import, so `setup`'s import closure must not include `@crane/storage`,
   `@crane/factory` or `@crane/http-server` (runtime is fine).
3. **Lazy serve and start.** The serve command still loads `cli/serve` and
   `cli/start` lazily (`test/boundaries.test.ts`), so other commands don't load
   the HTTP server or the orchestrator.
4. **Factory root.** `src/application.ts` derives the application root from its
   own file in `src/` or `dist/`, never from the runtime workspace. Its bound
   helpers are used by CLI startup, factory registration, dashboard builds,
   factory status and static serving. This preserves source checkout, compiled
   checkout and installed package roots.
5. **Build identity.** The CLI eagerly imports `src/application.ts` before
   setup or storage. It passes application root and compilation mode explicitly
   to runtime's `createFactoryBuildCheck`; compiled workspace dependencies do
   not imply compiled application execution. The captured build timestamp
   remains unchanged after rebuilding files. Source execution never reports
   backend staleness; compiled execution compares source and package inputs
   against the build loaded at bootstrap.
6. **Actor.** `serve` and `start` stay outside the host actor context; signed-in
   requests still run inside `withActor` (see [Shape](../CLAUDE.md)).
7. **Packaging and restart.** Each new package joins the root `dependencies`,
   `bundledDependencies`, `workspaces` and `tsconfig.packages.json`, so the
   tarball still needs no separate release. `crane start` keeps rebuilding with
   `npm run build`, which already builds every package; the restart notice
   already scans every `packages/*`.

Each extraction lands as one usable predecessor: package manifest and
lockfile metadata, workspace links (`npm install` in the operator's
checkout, which Crane's merge note reminds about), TypeScript references,
public imports, `project.json` and the Nx contract in [nx.md](nx.md) with
`test/nx-graph.test.ts`, test ownership in `scripts/test-groups.ts` and
[test-groups.md](test-groups.md), the boundary rules in
`test/boundaries.test.ts` and CLAUDE.md, the benchmark's case paths and
their owning `project` in `scripts/benchmark-tasks.ts` (checked by
`test/benchmark-tasks.test.ts`, which runs without sockets or child processes,
so sandboxed agents can run it directly), and this document. The tasks run one at a time,
each starting from its predecessor merged to `main`, because every extraction
rewrites the root manifest, root imports, architecture assertions and the
ownership catalog.

## Benchmark protocol

`scripts/benchmark-tasks.ts` runs the same workloads before and after each
extraction. It only runs the public commands (`npm run typecheck`,
`npm test`, and the two affected commands with `--base HEAD --working-tree`),
never changes configured checks, and never caches tests. Run it in an
authorized, clean checkout with dependencies installed (it refuses a dirty
tree, since affected runs compare HEAD with the working tree), with its output
in an ignored directory:

```sh
node --import tsx scripts/benchmark-tasks.ts --out .crane/benchmarks/<name> --phases plan
node --import tsx scripts/benchmark-tasks.ts --out .crane/benchmarks/<name> --phases full,changed,changed-uncached
```

Options: `--reps` (default 5) and `--secondary-reps` (default 3), `--cases`
to limit the edit cases. Through Crane's check handle the whole run's exit is
recorded too; the script exits 1 if any timed run exited non-zero.

**Cases.** Each case appends one valid export with a unique value to one small
file, so no run can replay another's cache entry, and restores the file's
exact bytes afterwards (also on SIGINT/SIGTERM):

| Case | Boundary | File today | Repetitions |
| --- | --- | --- | --- |
| `cli` | CLI-only | `src/cli/ui.ts` | 5, plus 3 uncached |
| `http` | HTTP-only | `src/server/body.ts` | 5, plus 3 uncached |
| `factory` | factory-only | `packages/factory/src/elapsed.ts` | 3 |
| `storage` | storage-only | `packages/storage/src/store/shared.ts` | 3 |
| `runtime` | runtime-only | `packages/backend-runtime/src/ids.ts` | 3 |
| `web` | web-only | `web/src/lib/format.ts` | 3 |
| `contracts` | shared-contract | `packages/contracts/src/errors.ts` | 3 |

An extraction that moves a case's file updates its path to the moved file, not
to a different module, so the logical edit stays the same.

**Phases.**

- `plan`: the dynamic suite inventory (`rootSuites` and `TEST_GROUPS`, never a
  remembered count) and each case's `--list` selection for both affected
  commands, written to `plan.json`.
- `full`: for each repetition, `tsc -b tsconfig.packages.json --clean` and
  `nx reset` (removing package `dist/` outputs and build info, and this
  checkout's `.nx/` cache and workspace data), then **cold** (first run after
  that reset), **warm** (immediate unchanged repeat) and **uncached**
  (`NX_SKIP_NX_CACHE=true`, with package outputs present, so `tsc -b` is up to
  date) runs of `npm run typecheck`; the same for `npm test` on the first three
  repetitions. Installed dependencies and the OS file cache are never cleared.
- `changed`: for each repetition and case, apply the probe, then time
  `affected:typecheck` and `affected:test`; restore. Rounds interleave cases
  so load drift spreads across them. The tree starts warm from the full phase.
- `changed-uncached`: the same for the focus cases with `NX_SKIP_NX_CACHE=true`.

**What each run records** (`measurements.jsonl`): workload, phase, case,
repetition, the exact command, the process's own exit code or signal, a
monotonic duration (`performance.now()` around the child), the wall-clock
duration (a disagreement over 1 s is flagged, after one earlier run's clock
stepped seven minutes), the load average at start, Nx's cache summary, the
node:test counts, and the path of the run's complete, unfiltered stdout and
stderr. `environment.json` records the commit, OS, CPU, cores, memory, load,
Node, npm, Nx and `scripts/nx-toolchain.mjs`'s versions. `summary.json` gives
median, minimum and maximum per workload, phase and case, plus
typecheck-plus-test per repetition.

**Comparable conditions.** Compare a candidate only with a baseline from the
same host, Node, npm, Nx, TypeScript and tsx versions, case set and repetition
counts, run with the same script. Report each candidate's suite inventory
beside the baseline's: added or removed suites change the work and must be
disclosed, not hidden in a median. Report every run, not just medians, and
treat runs with load averages above the cores available, or flagged clock
disagreement, as suspect and rerun them. Full and affected savings are separate
claims: affected selection reduces work; it is not cache speed.

## Measured baseline

Run by the baseline task (t-7tert8) on 2026-11-09 from 01:15 UTC, in its own
Crane worktree outside any sandbox, with `scripts/benchmark-tasks.ts` at
commit `c41f6db` and the default options: one `plan` run, then one
`full,changed,changed-uncached` run of 86 timed commands. Crane's check
handle recorded the whole run's exit as 0 after 2,442 s, and every one of the
86 commands exited 0 with no signal.

**Environment.** AMD Ryzen 7 8700F with 4 CPUs available, 23 GiB RAM, Linux
7.0.0-38-generic x64, shared with other Crane agents. Node v24.14.0, npm
11.9.0, Nx 24.0.5, TypeScript 7.0.2, esbuild 0.28.2, tsx 4.23.15, Vite 8.3.5,
workspace links ok. The one-minute load average at the start of each run was
0.5 to 4.1 (it includes the benchmark's own previous command). No run's wall
and monotonic durations differed by more than 1 s, so the wall clock didn't
step.

**Suite inventory** (`plan`, read from disk): 119 root suites, all owned, no
catalog problems: `backend` 71, `web` 17, `build` 10, `package-agent-drivers`
7, `architecture` 5, `package-agent-policy` 3, `package-worktree-deps` 3, and
one each for `package-contracts`, `package-agent-protocol` and
`package-diagnostics`. That is one more than the 118 in [nx.md](nx.md): this
task added `test/benchmark-tasks.test.ts` to `build`. A full run executes
1,107 tests.

### Selection matrix

Each row is the case's probe alone, `--base HEAD --working-tree --list`. No
case fell back to full work.

| Case | Typecheck projects | Test groups | Suites (tests run) |
| --- | --- | --- | --- |
| CLI-only (`src/cli/ui.ts`) | backend, checks | package-worktree-deps, backend, web, architecture, build | 106 (976) |
| HTTP-only (`src/server/body.ts`) | backend, checks | same 5 | 106 (976) |
| factory-only (`src/factory/elapsed.ts`) | backend, checks | same 5 | 106 (976) |
| storage-only (`src/core/store/shared.ts`, before extraction) | backend, checks | same 5 | 106 (976) |
| runtime-only (`packages/backend-runtime/src/ids.ts`) | backend, checks | same 5 | 106 (976) |
| web-only (`web/src/lib/format.ts`) | @crane/web, checks | same 5 | 106 (976) |
| shared-contract (`packages/contracts/src/errors.ts`) | contracts, agent-protocol, agent-policy, agent-drivers, web, backend, checks | all 10 | 119 (1,107) |

Every backend layer selects identical work today, and so does web, because
the `backend` and `web` groups each declare both projects and `backend`
depends on every package. This is what the extraction and the ownership split
have to change.

### Times

Monotonic seconds, median (range) over every run; every exit 0. Nx cache is
hits/tasks from Nx's own summary (none is printed with `NX_SKIP_NX_CACHE`).

| Workload | Phase | Runs | Median (range) | Nx cache |
| --- | --- | --- | --- | --- |
| `npm run typecheck` | cold | 5 | 3.27 (3.20–3.32) | 0/15 |
| | warm | 5 | 0.69 (0.67–0.72) | 9/15 |
| | uncached | 5 | 2.48 (2.42–2.50) | skipped |
| `npm test` (119 suites, 1,107 tests) | cold | 3 | 61.62 (61.59–62.29) | 0/6 |
| | warm | 3 | 60.49 (60.47–60.71) | 6/6 |
| | uncached | 3 | 60.53 (60.48–60.68) | skipped |
| Full typecheck + test | cold | 3 | 64.91 (64.89–65.60) | |
| | warm | 3 | 61.19 (61.16–61.43) | |
| | uncached | 3 | 62.95 (62.90–63.17) | |

| Case | Phase | Runs | `affected:typecheck` | `affected:test` | Typecheck + test |
| --- | --- | --- | --- | --- | --- |
| CLI-only | changed | 5 | 2.03 (2.00–2.07), 6/8 | 57.39 (57.14–57.53), 6/6 | **59.42** (59.15–59.53) |
| HTTP-only | changed | 5 | 2.03 (2.02–2.05), 6/8 | 57.50 (57.29–57.76), 6/6 | **59.54** (59.31–59.78) |
| factory-only | changed | 3 | 2.07 (2.07–2.08), 6/8 | 57.22 (57.17–57.45), 6/6 | 59.29 (59.24–59.53) |
| storage-only | changed | 3 | 2.08 (2.03–2.11), 6/8 | 57.53 (57.18–57.73), 6/6 | 59.61 (59.21–59.84) |
| runtime-only | changed | 3 | 2.10 (2.06–2.11), 6/8 | 57.42 (57.21–57.65), 6/6 | 59.49 (59.31–59.76) |
| web-only | changed | 3 | 2.08 (2.06–2.20), 6/8 | 57.44 (57.40–57.56), 6/6 | 59.63 (59.46–59.64) |
| shared-contract | changed | 3 | 2.84 (2.84–2.91), 2/13 | 60.68 (60.65–61.12), 6/6 | 63.52 (63.48–64.03) |
| CLI-only | changed-uncached | 3 | 2.28 (2.22–2.28) | 57.72 (57.62–57.77) | 60.00 (59.90–60.00) |
| HTTP-only | changed-uncached | 3 | 2.21 (2.20–2.29) | 57.59 (57.52–57.73) | 59.88 (59.74–59.93) |

Full typecheck-plus-test pairs sum the same repetition's two runs; cold
typecheck and cold test each followed their own reset. Today an affected loop
for any backend or web edit is only about 3% faster than the full warm loop
(59.4 s against 61.2 s), and tests are 96% of it. The typecheck half is
already narrow (backend and checks; `checks` alone is about 1.7 s and depends
on everything).

## Success targets

The extraction series (task t-u6gyh4 verifies it) succeeds only if, under the
comparable conditions above:

- **CLI-only edit:** the median `affected:typecheck` plus `affected:test`
  time (`changed` phase, `cli` case) is **at least 20% lower** than this
  baseline's median for the same case.
- **HTTP-only edit:** the same, at least 20% lower, for the `http` case.
- **Full checks:** the medians of `npm run typecheck` and `npm test` are each
  **no more than 10% slower** than this baseline's, in each of the cold, warm
  and uncached phases.
- Process exits stay 0 for every run, full `npm test` runs every root suite
  that exists at the candidate, and tests stay uncached.

Against this baseline those thresholds are:

| Target | Baseline median | Threshold |
| --- | --- | --- |
| CLI-only affected typecheck + test | 59.42 s | ≤ 47.54 s |
| HTTP-only affected typecheck + test | 59.54 s | ≤ 47.63 s |
| `npm run typecheck`, cold / warm / uncached | 3.27 / 0.69 / 2.48 s | ≤ 3.60 / 0.76 / 2.73 s |
| `npm test`, cold / warm / uncached | 61.62 / 60.49 / 60.53 s | ≤ 67.78 / 66.54 / 66.58 s |

A 20% cut means the CLI and HTTP selections must drop roughly 12 s of the
57 s test half, since typecheck is only 2 s. That needs the test-ownership
split along the new packages, not just the extraction. If the suite inventory
grows before the comparison, disclose the new suites and their selected time
rather than adjusting the threshold.

## Not measured

These are not established by this baseline and remain outstanding acceptance
work for task t-u6gyh4, not conclusions:

- **The comparison itself.** No candidate exists yet, so whether any target
  is met is unknown. Each extraction task should rerun the benchmark on its
  candidate; t-u6gyh4 decides acceptance.
- **Cold affected runs.** Affected commands were measured warm (`changed`) and
  uncached, never right after a reset.
- **Independent arms.** Every run shared one worktree, its installed
  dependencies and the OS file cache. The candidate will be measured in a
  different worktree, so disclose that and keep the host and tool versions.
- **Selection overhead on its own.** `--list`, the link check and an
  up-to-date `tsc -b` weren't timed separately in this run; the earlier
  figures in [nx.md](nx.md#measured-results) (0.55 s, 0.02 s and 0.04 s)
  are from a different commit.
- **Quiet host.** Other Crane agents shared the host (load up to 4.1 on 4
  CPUs). Ranges are tight (under 1.2 s for every test median), but load wasn't
  controlled.
- **Node 20.19**, Crane's minimum: no Node 20 runtime was available.
- **Packaged CLI and installed-tarball identity** (`factoryRoot()` from an
  installed package, `crane setup` with a broken native binding): contract
  items 2, 4 and 5 above are checked by reading code, not by running a packed
  build.
- **Codex's no-network sandbox**, where `npm test` can't run.

## Runtime extraction implementation

The five runtime modules now live in `packages/backend-runtime/src/`, with explicit named exports in `index.ts` (no implementation subpaths). `currentActor` stays internal; all actor consumers import the package entry. The application binds `factoryRoot`, `factoryBuildOutdated` and the default served dashboard in `src/application.ts`, whose location is the application's `src/` or `dist/`, including installed packages. The CLI eagerly imports this identity before setup or storage. Runtime receives root and compilation mode explicitly; package location cannot identify the application. The loaded timestamp is captured once and remains unchanged after an on-disk rebuild. Existing backend and build suite groups conservatively cover runtime through the backend dependency closure; narrower ownership remains a subsequent task. Application builds remain uncached. No timing improvement is claimed by this extraction.

## Storage extraction implementation

Store and its domain modules, post-mortem helpers, screenshot retention and maintenance now live in `packages/storage/src/`. Production consumers use `@crane/storage`'s single public entry; repository tests can still exercise private algorithms through source paths. Schema, migrations, transactions and domain implementations moved unchanged. Storage depends only on contracts, backend-runtime, Node and better-sqlite3. The root retains its SQLite dependency for the documented CLI setup native-module probe; all database operations remain storage-owned. Nx and composite references include storage; existing broad suite groups cover it through backend's dependency closure until the separate ownership partition task. The benchmark's storage probe follows its new package path. No timing improvement is claimed here.

## Factory extraction implementation

All former `src/factory/` modules now live together under
`packages/factory/src/`, including OperatorActions and its domain modules,
validation, drivers/settings, the orchestrator, checks, work/merge execution,
dashboard builds and checkpoint services. Their internal organization and
safety gates are preserved. The package compiles with its own `rootDir: src`
and composite declarations, and references its actual downward dependencies:
storage, backend-runtime, contracts, agent-drivers, agent-policy,
agent-protocol, diagnostics and worktree-deps. CLI and HTTP implementation
remain application-owned and cannot be imported by factory.

Production uses focused entries: `/actions` for operator mutations, `/state`
and the default entry for read-only status, `/runtime` for Factory and serving
driver selection, and `/settings`, `/diff` and `/instruct` for externally
consumed utilities. Run services, merge helpers and checkpoints stay private.
The driver registry remains the only production importer of concrete drivers;
all protocol consumers still share the same package and error class.

Application identity is explicitly bound by `src/application.ts` into the
backend-runtime singleton before CLI or HTTP composition. Factory services
consume that binding rather than importing application source or guessing its
location from a compiled workspace. Source, compiled and installed application
locations continue to be determined by the application marker itself. Private
source tests also consume this one identity through backend-runtime.

Workspace manifests, lock metadata, bundling, composite references, Nx edges,
test dependency assertions and the benchmark factory probe follow the new
package. Broad backend/web test ownership remains conservative through the
backend dependency closure; narrowing it and partitioning checks compilation
remain serialized follow-up tasks. Tests and application bundles stay uncached,
with checkout-local cache configuration unchanged. No timing improvement is
claimed by this extraction; full/affected workload comparison remains the
series' verification task in an environment supporting the complete suites.
