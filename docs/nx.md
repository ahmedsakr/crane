# Nx project graph

Status: **foundation**, 2026-11-08. Nx models Crane's projects and targets so
later work can run only the checks a change affects. Nothing calls Nx yet:
`npm run build`, `npm run typecheck`, `npm test` and every other public script
behave exactly as before, and npm is still the only installer. Wiring full and
affected commands, splitting the root suites into test groups, and measuring
whether Nx is faster are separate follow-up tasks. They build on the names and
contract below, so change them only together with this document and
`test/nx-graph.test.ts`.

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

Not verified locally: Crane's command guard refused this task's attempt to run
`nx show projects` in the worktree, so Nx itself hasn't parsed this
configuration yet. `test/nx-graph.test.ts` checks the files Nx reads, not Nx's
computed graph. The first follow-up that runs Nx (`nx show projects --json`,
`nx graph --file=<tmp>.json` with `NX_DAEMON=false`) should confirm the nine
projects and their edges before relying on them.

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
| `build` | Packages: `tsc -b packages/<dir>/tsconfig.json`, which type-checks and emits `dist/` with its build info. Backend: the same esbuild command as `build:backend`, emitting the root `dist/`. Web: `vite build` into `web/dist/`. Each depends on `^build` | local |
| `typecheck` | Packages: `nx:noop` after `build`, because a composite build is the type check. Backend: `tsc -p tsconfig.json --noEmit`. Web: `tsc -p tsconfig.json --noEmit` in `web/`. Checks: `tsc -p tsconfig.test.json`. Each depends on the builds it imports: `^build`, and for checks the six package builds, not the backend or web bundles | local |
| `test` | `checks` only: `node --import tsx --test test/*.test.ts`, after the six package builds | **never** |

Every executing target first runs `node scripts/check-workspace-links.mjs`, the
same preflight `build:packages` runs, so a stale install stops with the usual
"run npm install" message. Commands are copied from the public scripts rather
than calling `npm run`, so Nx doesn't start npm for each task;
`test/nx-graph.test.ts` fails if a copy drifts from its script.

`test` is not cacheable until a later task shows that replaying a suite's
result is safe. Its inputs are every non-ignored file in the repository plus
`sharedGlobals`, so any change makes it affected until the suites are split into
groups with complete ownership.

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
acyclic, the target contract and its commands against the npm scripts, the
inputs above, the local-only settings, the exact pin, and the toolchain probe.
