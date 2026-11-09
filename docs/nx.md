# Nx project graph

Status: **measured**, 2026-11-08. Nx models Crane's projects and targets,
and `npm run typecheck`, `npm test` and two affected commands run through it
(see [Commands](#commands)). `npm run build`, `build:packages`, dev and the
source CLI don't use Nx, and npm is still the only installer. Nx makes repeated
and most changed-project typechecks faster, but **not tests**, which are 96% of
the time: see [Measured results](#measured-results) for the verdict and what is
still open. Change the names and contract below only together with this
document and `test/nx-graph.test.ts`.

Root suite ownership and the uncached runner are described in
[Root test ownership](test-groups.md). The planned split of `backend` into
runtime, storage, factory and HTTP packages, and its timing baseline, are in
[Backend extraction](backend-extraction.md). Suite counts below are from the
commits measured then.

## Version and compatibility

Crane pins `nx` **24.0.5** exactly in the root `devDependencies`, installed with
`npm install --save-dev --save-exact nx@24.0.5` (npm 11.9.0, Node v24.14.0).
24.0.5 was `latest` on npm when chosen. It was released on 2026-11-06, and it is a
fixes-only release on top of 24.0.0, which was released on 2026-10-21
([24.0.5 release](https://github.com/nrwl/nx/releases/tag/24.0.5),
[24.0.0 release](https://github.com/nrwl/nx/releases/tag/24.0.0)).

| Concern | Evidence |
| --- | --- |
| TypeScript 7 | `nx` has no `typescript` dependency (`npm view nx@24.0.5 dependencies`), and adding it left `node_modules/typescript` 7.0.2 as the lockfile's only `tsc` bin (`test/build.test.ts`). Nx's import scan uses its native binding (`findImports` in `packages/nx/src/plugins/js/project-graph/build-dependencies/explicit-project-dependencies.ts` at 24.0.5), not the compiler API, which TypeScript 7 doesn't have. No `@nx/js` or other plugin is installed, so nothing brings `@typescript/typescript6` or an old `tsc` |
| Node >=20.19 | The 24.0.5 manifest declares no `engines`. Nx's compatibility-matrix pages returned HTTP 404 when checked, so **no official Node row for Nx 24 was found**. Treat Node 20.19 support as unverified until a run on Node 20 passes. The acceptance host had no Node 20 runtime, so this is still open |
| npm | npm workspaces stay the package source; Nx reads them through its built-in package.json plugin. There is no `packageManager` field and no other lockfile |
| Native binaries | `nx` ships platform binaries as optional `@nx/nx-<platform>` dependencies; the lockfile lists all ten. Only Linux x64 was installed here |
| Peer dependencies | `@swc/core` and `@swc-node/register` are optional peers, used only to load `.ts` config files. Crane's Nx config is JSON |

The 24.0.0 breaking changes that matter here: a project.json without a `name`
takes the package.json name, `nx:run-commands` runs commands directly by default,
and the `dependsOn` `self`/`dependencies` shorthand was removed. Every
project.json here sets `name` to the package name and uses the object `dependsOn`
form, so none of them changes the graph.

The wiring task ran `nx show projects --json` with `NX_DAEMON=false` (Node
v24.14.0, Linux x64): Nx lists exactly the nine projects below. A full
typecheck has 15 tasks, 9 of them cacheable: the six package `typecheck`
targets are no-ops and don't cache. `test/nx-graph.test.ts` checks the files
Nx reads, not Nx's computed graph.

## Projects

Project names are stable. Packages and web use their npm names, so the names
Nx infers from package.json and the ones in project.json can't disagree.

| Project | Root | Depends on | Targets |
| --- | --- | --- | --- |
| `@crane/contracts` | `packages/contracts` | none | `build`, `typecheck` |
| `@crane/agent-protocol` | `packages/agent-protocol` | contracts | `build`, `typecheck` |
| `@crane/agent-policy` | `packages/agent-policy` | contracts | `build`, `typecheck` |
| `@crane/diagnostics` | `packages/diagnostics` | none | `build`, `typecheck` |
| `@crane/worktree-deps` | `packages/worktree-deps` | diagnostics | `build`, `typecheck` |
| `@crane/agent-drivers` | `packages/agent-drivers` | contracts, agent-protocol, agent-policy, diagnostics | `build`, `typecheck` |
| `@crane/web` | `web` | contracts | `build`, `typecheck` |
| `backend` | `src` | all six packages (the root manifest's `@crane/*` dependencies) | `build`, `typecheck` |
| `checks` | `test` | every other project | `typecheck`, `test` |

Each project's `implicitDependencies` lists its edges explicitly. For packages
and web they equal the manifest's `@crane/*` dependencies, which equal the
package's TypeScript `references`. Nx would also infer them from package.json
and imports, and the explicit lists make the intended graph checkable without
running Nx. `checks` covers both `test/` and `scripts/`, the two directories
`tsconfig.test.json` compiles.

**No root project.** Nx 24 makes the root package.json a project only when it
has an `nx` field or a project.json beside it (`packages/nx/src/plugins/package-json/create-nodes.ts`).
Crane has neither. The root manifest is the backend's, so its `@crane/*`
dependencies become `backend`'s edges, and nothing can depend on a root hub that
owns every file. Root files belong to no project and reach tasks only through
`sharedGlobals` (below), which is what makes them global.

Inferred npm-script targets: Nx turns each workspace's package.json scripts
into `nx:run-script` targets. Every `build` and `typecheck` above replaces the
script target of the same name, because a project.json target with its own
executor wins. The leftover inferred targets (packages' `dev`, web's `dev`,
`preview` and lifecycle scripts) just call npm and aren't part of the contract.

## Targets

| Target | Meaning | Cache |
| --- | --- | --- |
| `build` | Packages: `tsc -b packages/<dir>/tsconfig.json`, which type-checks and emits `dist/` with its build info. Backend: the same esbuild command as `build:backend`, emitting the root `dist/`. Web: `vite build` into `web/dist/`. Each depends on `^build` | packages local; backend and web **never** |
| `typecheck` | Packages: `nx:noop` after `build`, because a composite build is the type check. Backend: `tsc -p tsconfig.json --noEmit`. Web: `tsc -p tsconfig.json --noEmit` in `web/`. Checks: `tsc -p tsconfig.test.json`. Each depends on the builds it imports: `^build`, and for checks the six package builds, not the backend or web bundles | local |
| `test` | `checks` only: `node --import tsx scripts/run-test-groups.ts --full`, after the six package builds | **never** |

Package builds cache because their output is complete: `outDir` and
`tsBuildInfoFile` are both inside the `dist/` Nx stores and restores, so a
restored package carries the composite build state that matches it, and a
later `tsc -b` sees it as up to date. The backend and web bundles don't cache:
`src/core/webbuild.ts` decides whether the running factory and dashboard are
outdated from the mtimes of `dist/` and `web/dist/`, and Nx leaves matching
outputs untouched on a cache hit, so a restored build could keep the notice up
(or hide it) after a rebuild. No public command runs those two targets.

Every executing target first runs `node scripts/check-workspace-links.mjs`, the
same preflight `build:packages` runs, so a stale install stops with the usual
"run npm install" message. Commands are copied from the public scripts rather
than calling `npm run`, so Nx doesn't start npm for each task;
`test/nx-graph.test.ts` fails if a copy drifts from its script.

`test` is not cacheable until a later task shows that replaying a suite's
result is safe. Its inputs are every non-ignored file in the repository plus
`sharedGlobals`. Affected test selection doesn't use Nx's `affected`; it uses
the group ownership in [Root test ownership](test-groups.md).

## Commands

`scripts/tasks.ts` is the one place public scripts start Nx. No Nx target
starts npm, Nx or `scripts/tasks.ts`, so nothing recurses, and the root has no
`pretest` or `pretypecheck` hook to repeat the work.

| Command | What runs |
| --- | --- |
| `npm run typecheck` | Link check, then `nx run-many -t typecheck` over all nine projects: every package build, backend, web, and tests with scripts |
| `npm test` | Link check, `nx run-many -t build` for the six packages, then one runner over every root suite (`testPlan`, the same files as the old `test/*.test.ts` glob) |
| `npm run affected:typecheck -- --base <rev> (--head <rev> \| --working-tree)` | Link check, then `typecheck` for the changed projects and every project that depends on them |
| `npm run affected:test -- --base <rev> (--head <rev> \| --working-tree)` | Link check, the six package builds, then the suites of the affected test groups |

Add `--list` to an affected command to print its selection and the Nx command
as JSON without running anything. The link check (`scripts/check-workspace-links.mjs`)
runs in `scripts/tasks.ts` before Nx starts, so a cache hit can never skip it.
Nx runs with `NX_DAEMON=false`, `NX_NO_CLOUD=true`, `NX_TUI=false` and
`--outputStyle=static-failures-only`: failing tasks print in full, successful
and cached ones in one line. The exit status is Nx's or the runner's own,
through npm; a usage error exits 2.

### Choosing the comparison

There is no default base and nothing assumes `HEAD~1`. `--base` is the
known-good revision, such as `main` or the commit a candidate was built on.
Compare it with exactly one of:

- `--head <rev>`: committed changes only. The head must be the checked-out
  commit with no local changes, since checks run on the files on disk;
  otherwise the command runs everything and says why.
- `--working-tree`: the files on disk, counting staged, unstaged and deleted
  files and untracked files that aren't ignored.

Changes come from `git diff --name-only --no-renames` between the two trees,
from local history only (nothing fetches). Without rename detection, a rename
counts as both its old and new path. A tree comparison rather than a merge-base
one also counts files the base changed and the head lacks.

### Falling back to full work

Each of these runs the full command and prints the reason, rather than a
smaller or empty selection: a base or head that isn't a commit in local history,
Git missing or not a checkout, a head equal to the base (a candidate compared
with itself), a head that isn't checked out or has local changes, and no
changed files at all.

`affected:typecheck` also runs everything for any `sharedGlobals` file, any
project's `project.json`, `package.json` or `tsconfig*.json` (they can change
the graph), any file no project owns (such as `bin/` or a new package without a
project.json), an unreadable graph, and a change set with no typecheck input.
Markdown outside a project is the one thing it skips, since no tsconfig compiles
it. Files under `scripts/` belong to `checks`, which `tsconfig.test.json` also
compiles. For example, a change to `packages/contracts/src/` type-checks
contracts, agent-protocol, agent-policy, agent-drivers, web, backend and checks,
and a change to `packages/diagnostics/src/` skips contracts, agent-protocol,
agent-policy and web.

`affected:test` passes the change set (or "unavailable") to
`affectedTestGroups`, whose fallbacks are listed in
[Root test ownership](test-groups.md#enumeration-and-conservative-selection).
A fallback runs the full suite set in one runner invocation.

`test/tasks.test.ts` checks argument handling, change resolution in disposable
Git repositories, selection over the real graph, and the order and exit status
of each step. `test/tasks-process.test.ts` runs the real npm scripts in a
disposable checkout with a fake Nx.

## Inputs and invalidation

`nx.json` defines two named inputs:

- `default`: `{projectRoot}/**/*` plus `sharedGlobals`. Every cacheable target uses
  it, and adds `^default` so a dependency's sources and configuration count too.
  Backend `build` adds `bin/`. Checks' `typecheck` adds `scripts/`. Nx doesn't
  hash ignored files, so `dist/`, `node_modules/` and `.nx/` never count.
- `sharedGlobals`, which changes every task's hash and makes every task affected:
  - `nx.json`, the root `package.json` and `package-lock.json`, every root
    `tsconfig*.json`, and `.gitignore` (which decides which files Nx sees)
  - the task scripts targets run or mirror: `scripts/build.mjs`,
    `scripts/check-workspace-links.mjs` and `scripts/nx-toolchain.mjs`
  - `{ "runtime": "node scripts/nx-toolchain.mjs" }`: the Node version,
    platform and CPU architecture, the installed versions of TypeScript,
    esbuild, tsx, Nx and Vite (read from `node_modules`, so a stale install
    differs from the lockfile), and whether every workspace link is correct
  - `NODE_OPTIONS` and `NODE_ENV`, which change how Node and Vite run

Projects' own manifests, tsconfigs and project.json files are under their
`{projectRoot}`. No input lists `externalDependencies`, so Nx keeps hashing
every installed package a project uses. Listing some would hash only those.

## Execution

- `useDaemonProcess: false`. No background process keeps a graph between runs
  or outlives a task's worktree.
- `neverConnectToCloud: true`, with no Cloud id, token, URL, custom runner,
  remote cache or plugin. The cache is local, under the ignored `.nx/` in each
  checkout or worktree, so worktrees don't share results.
- Nx's default parallelism applies. No target sets `parallel` yet.

`test/nx-graph.test.ts` checks the project set and names, that there's no
root project, the edges against manifests and references, that the graph is
acyclic, the target contract and its commands against the npm scripts, that
public scripts reach Nx only through `scripts/tasks.ts` and no target recurses,
which targets cache, the inputs above, the local-only settings, the exact pin,
and the toolchain probe.

## Verified behavior

The final acceptance task (t-knjtzz, candidate `6037298`) checked these in its
own fresh Crane worktree, outside any sandbox:

| Behavior | What was observed |
| --- | --- |
| Fresh worktree install | Crane's dependency preparation gave the worktree `nx` 24.0.5 with its `@nx/nx-linux-x64-gnu` binary and correct workspace links (`scripts/nx-toolchain.mjs` reports `workspaceLinks: ok`). The worktree had no `.nx/` and no package `dist/`, and its first `npm run typecheck` ran all 15 tasks with 0/15 cache hits |
| No cross-worktree cache | `~/.nx/6c369d3128b6274a/` holds package outputs written by checkouts that predate the relative `cacheDirectory` (newest entry 17:53, before this task's first Nx run). None of them was read (that first run was 0/15) and none was written: after more than 140 Nx runs, nothing under `~/.nx` was newer than the task's start, while `.nx/cache` and `.nx/workspace-data` in the worktree held everything |
| Invalidation | With a distinct patch per run, exactly the edited project and its consumers missed. Full typecheck hits: a contracts edit 2/15 (only diagnostics and worktree-deps builds hit), worktree-deps 6/15, backend or web 7/15, a root suite 8/15 (only `checks` reran). Reverting the patch hit again (9/15) |
| Output restoration | `tsc -b tsconfig.packages.json --clean` deleted every package output file and build info. The next `npm run typecheck` restored all six packages from the cache (144 files, each with its `tsconfig.tsbuildinfo`) in 0.7 s, and `tsc -b --verbose` then reported every project up to date, rebuilding nothing |
| Failure propagation | A type error in `src/factory/elapsed.ts` failed `npm run affected:typecheck -- --base HEAD --working-tree` and then the full `npm run typecheck` with exit 1 (`backend` and `checks` failed). A deliberately failing assertion in `test/report.test.ts` failed `npm run affected:test` with exit 1 after its 15 suites |
| Fallbacks | `--list` with a missing base (`refs/heads/benchmark-missing-base`), `--base HEAD --head HEAD`, and an unchanged `--working-tree` each selected full work and printed why. Omitting `--head`/`--working-tree` exits 2 with usage |
| Concurrency | Two `npm run typecheck` runs started together in one worktree, on a change neither had cached, both ran `backend` and `checks` and passed. One sample only |
| Dashboard and build | `npm run build -w web` (contracts prebuild, then Vite) and `npm run build` passed. `test/build.test.ts` checks that neither starts Nx |

### Selection matrix

Each row is one temporary working-tree change, previewed with
`--base HEAD --working-tree --list` and then restored. There are 9 projects
and 118 root suites.

| Change | Typecheck projects | Test groups / suites |
| --- | --- | --- |
| `packages/contracts/src/` | 7 (all but diagnostics, worktree-deps) | 10 / 118 |
| `packages/diagnostics/src/` (edit, delete, rename or new file) | 5 | 8 / 114 |
| `packages/agent-policy/src/` | 4 | 9 / 117 |
| `packages/worktree-deps/src/` | 3 | 6 / 106 |
| `src/` | 2 (backend, checks) | 5 / 105 |
| `web/src/` | 2 (web, checks) | 5 / 105 |
| One root suite (`test/report.test.ts`) | 1 (checks) | 3 / 15 |
| `test/support/`, `scripts/` | 1 (checks) | full: global input |
| A new root suite | 1 (checks) | full: unassigned suite |
| `docs/nx.md` | full: no typecheck input | full |
| `nx.json`, `package-lock.json`, a package `tsconfig.json`, `bin/` | full | full |

Typecheck narrows well. Tests barely narrow: the `backend` group (71 suites)
depends on backend and web, whose closure is every package, so any package,
backend or web edit selects it, together with `web` and both repository-wide
groups.

## Measured results

Host: AMD Ryzen 7 8700F with 4 CPUs available, 23 GiB RAM, Linux 7.0.0 x64,
shared with other Crane agents (load average 0.9 to 6). Node v24.14.0, npm
11.9.0, Nx 24.0.5, TypeScript 7.0.2, esbuild 0.28.2, tsx 4.23.15, Vite 8.3.5.
All arms ran in the same worktree with the same installed dependencies,
alternating order. The baseline is d458eef's pre-migration scripts verbatim:
`npm run build:packages && tsc -p tsconfig.json --noEmit && tsc -p
tsconfig.test.json && npm run typecheck -w web`, and `npm run build:packages &&
node --import tsx --test test/*.test.ts` (the same 118 suites and 1,099 tests
as `npm test`). Times are wall seconds, median (range).

### Typecheck (5 runs per arm)

| Workload | Baseline | Nx `typecheck` | Nx `affected:typecheck` | Nx cache hits |
| --- | --- | --- | --- | --- |
| Cold: package outputs cleaned, `nx reset` | 3.09 (3.03–3.11) | 3.25 (3.13–3.28), +5% | | 0/15 |
| Warm: unchanged repeat | 2.38 (2.34–2.43) | **0.69** (0.68–0.70), −71% | | 9/15 |
| Uncached: `NX_SKIP_NX_CACHE=true` | 2.36 (2.34–2.40) | 2.38 (2.27–2.39), +1% | | none |
| Changed: contracts | 2.55 (2.53–2.63) | 2.69 (2.67–2.82), +5% | 2.76 (2.73–2.81), 7 projects | 2/15, 2/13 |
| Changed: worktree-deps | 2.47 (2.43–2.51) | 2.15 (2.13–2.18), −13% | 2.15 (2.12–2.18), 3 projects | 6/15, 5/9 |
| Changed: backend `src/` | 2.40 (2.37–2.44) | 1.98 (1.96–2.06), −18% | 2.02 (1.97–2.05), 2 projects | 7/15, 6/8 |
| Changed: `web/src/` | 2.39 (2.37–2.43) | 2.00 (1.95–2.08), −16% | 2.08 (2.00–2.11), 2 projects | 7/15, 6/8 |
| Changed: one root suite | 2.41 (2.35–2.43) | 1.77 (1.69–1.77), −27% | 1.80 (1.76–1.83), 1 project | 8/15, 6/7 |

The first warm Nx run (2.39 s, 0/15) followed a cold baseline run's reset and is
excluded from the warm range. Each changed run appended a distinct valid export,
so no run could replay another's entry, and the tree was restored and re-warmed
between runs.

### Tests

| Workload | Baseline | Nx | Package builds from cache |
| --- | --- | --- | --- |
| Full: `npm test` (5 runs) | 60.30 (59.76–60.66), 4 runs | 60.71 (60.42–61.76), +0.7% | 6/6 |
| Affected, worktree-deps edit: 106 suites, 984 tests (3 runs) | same groups without Nx: 57.23 (57.13–57.31) | 58.17 (57.78–58.24), −3.5% against full | 5/6 |
| Affected, backend edit: 105 suites, 969 tests (3 runs) | 57.19 (56.78–57.65) | 58.15 (57.95–58.21), −3.6% | 6/6 |
| Affected, one root suite: 15 suites, 159 tests (3 runs) | 11.74 (11.72–11.78) | 12.58 (12.57–12.59), −79% | 6/6 |

The first baseline full run measured 504 s by `/usr/bin/time`, but its runner's
own monotonic `duration_ms` was 64.6 s: the host's wall clock stepped about
seven minutes during it (11 wall minutes passed while uptime advanced 5), so it
is excluded. Later test runs also recorded a monotonic duration, which matched
`/usr/bin/time` within 0.01 s.

Fixed costs per command: affected selection (`--list`, including npm startup)
0.55 s for tests and 0.23 s for typecheck; the link check 0.02 s; an up-to-date
`tsc -b` 0.04 s, against about 0.35 s for Nx to confirm six cached package
builds. So `affected:test` costs about 0.9 s more than running the same groups
directly.

### Verdict

- **Typecheck: useful improvement.** An unchanged repeat is 3.4× faster, and
  backend, web, leaf-package and suite edits are 13–27% faster than the
  baseline, with correct invalidation. A contracts edit is 5–8% slower, because
  Nx runs six `tsc -b` processes where the baseline runs one solution build.
  `affected:typecheck` saves nothing over `npm run typecheck`: the cache
  already skips unchanged projects, and `checks` (`tsc -p tsconfig.test.json`,
  about 1.7 s) depends on everything and always reruns.
- **Tests: no useful improvement, so performance acceptance for tests is
  unresolved.** Tests are about 96% of a typecheck-plus-test loop (60 s against
  2.4 s). Nx neither caches them (by design) nor narrows them much: a backend
  edit's loop goes from 62.7 s to 60.2 s (−4%). Only edits confined to root
  suites gain (−79%). Speeding up tests needs finer ownership, such as splitting
  the 71-suite `backend` group by what its suites import, or faster suites, not
  more orchestration.

## Still open

- Nx on Node 20.19, Crane's minimum: no Node 20 runtime was available.
- A second independent install: cloning the worktree into a disposable
  directory for `npm ci` and separate benchmark copies was refused by Crane's
  command guard, so every arm shared one worktree (and its OS file cache), and
  fresh-install evidence is this one Crane-prepared worktree.
- The packaged CLI: beyond the passing build and `test/build.test.ts`'s static
  checks, listing the `npm pack --dry-run` contents and running the built CLI's
  `--help` were refused in the same run.
- Nx under Codex's no-network sandbox, and more than one concurrency sample.
- Stale shared entries in `~/.nx/6c369d3128b6274a/` from pre-fix checkouts.
  Current Crane ignores them; an operator may delete the directory.
