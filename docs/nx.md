# Nx project graph

Status: **commands wired**, 2026-11-08. Nx models Crane's projects and targets,
and `npm run typecheck`, `npm test` and two affected commands run through it
(see [Commands](#commands)). `npm run build`, `build:packages`, dev and the
source CLI don't use Nx, and npm is still the only installer. Measuring whether
Nx is faster is a separate follow-up. Change the names and contract below only
together with this document and `test/nx-graph.test.ts`.

Root suite ownership and the uncached runner are described in
[Root test ownership](test-groups.md).

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
| Node >=20.19 | The 24.0.5 manifest declares no `engines`. Nx's compatibility-matrix pages returned HTTP 404 when checked, so **no official Node row for Nx 24 was found**. Treat Node 20.19 support as unverified until a run on Node 20 passes (follow-up: the lifecycle verification task) |
| npm | npm workspaces stay the package source; Nx reads them through its built-in package.json plugin. There is no `packageManager` field and no other lockfile |
| Native binaries | `nx` ships platform binaries as optional `@nx/nx-<platform>` dependencies; the lockfile lists all ten. Only Linux x64 was installed here |
| Peer dependencies | `@swc/core` and `@swc-node/register` are optional peers, used only to load `.ts` config files. Crane's Nx config is JSON |

The 24.0.0 breaking changes that matter here: a project.json without a `name`
takes the package.json name, `nx:run-commands` runs commands directly by default,
and the `dependsOn` `self`/`dependencies` shorthand was removed. Every
project.json here sets `name` to the package name and uses the object `dependsOn`
form, so none of them changes the graph.

The wiring task ran `nx show projects --json` with `NX_DAEMON=false` (Node
v24.14.0, Linux x64): Nx lists exactly the nine projects below. A cold full
typecheck through Nx took 3.0 s wall time and a warm one 0.55 s, with 9 of 15
tasks from the cache (the six package `typecheck` targets are no-ops and don't
cache). `test/nx-graph.test.ts` checks the files Nx reads, not Nx's computed
graph.

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

Not verified yet, left to the lifecycle verification task: Nx on Node 20,
restoring package outputs from the cache after `dist/` is deleted (Crane's
command guard refused this task's attempt to delete `dist/`), concurrent runs
in one worktree, and Nx under Codex's no-network sandbox.
