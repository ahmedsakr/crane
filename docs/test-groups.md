# Root test ownership and runner interface

This layer publishes ownership and execution interfaces. `npm test` builds the
packages through Nx and runs every root suite with this runner, and
`npm run affected:test` runs the suites `affectedTestGroups` selects; see
[Commands](nx.md#commands). There is no test-result cache.

`scripts/test-groups.ts` assigns every immediate `test/*.test.ts` suite exactly
once. Group ids are stable interfaces for `scripts/tasks.ts`:

| Group | Scope and dependencies |
| --- | --- |
| `package-contracts` | Shared labels and pure contract helpers |
| `package-agent-protocol` | Report parsing; protocol and contracts |
| `package-agent-policy` | Permission rules; policy and contracts |
| `package-agent-drivers` | Driver streams, hooks, process helpers and protocol parity |
| `package-diagnostics` | Redaction and both consumers; diagnostics, drivers and worktree-deps |
| `package-worktree-deps` | Dependency preparation, installation, copying and progress |
| `backend-runtime` | Actor context and runtime helpers |
| `storage` | Store persistence, indexes, claims, analytics and summaries |
| `factory-actions` | Operator actions, goals, crew, queue, scheduling and retention settings |
| `factory-agents` | Agent runs, drivers, cost, prompts, evidence and restart |
| `factory-execution` | Work and merge execution, checks, storage diagnostics and worktrees |
| `storage-agent-evidence`, `storage-check-reports` | Stored command/cost evidence from drivers and check report evidence from the protocol |
| `http` | Routes, authentication, exposure and sign-in limiting |
| `http-factory` | Factory and storage behavior exercised through HTTP |
| `cli` | Command registration, operator commands, setup and startup |
| `cli-http` | Attribution across CLI and HTTP, auth bootstrap, serving and TLS |
| `web` | Pure web helpers and rendering, including browser scheduling behavior |
| `web-http`, `web-policy` | Client/server behavior for Home and operator APIs, and UI parity with command guard categories |
| `architecture` | Repository-wide source shape, boundaries, export probes, manifests, graph and ownership scans |
| `build` | Repository-wide build ordering, workspace links, dashboard staleness, screenshots and runner contracts |

An execution owner can consume several projects. For example, diagnostics
tests import private driver and dependency-install sources, and the Home
integration drives the web model from the real HTTP overview. The architecture
owner includes the contracts suite because it scans package and web source and
root manifests.

At the ownership split, a CLI-only edit selected 28 of 131 suites, an HTTP-only
edit selected 49, and a web-only edit selected 35. The earlier CLI and HTTP
probes selected 106 of 119 suites. These are selection counts. Package builds
and repository-wide scans still contribute to the affected workload.
[Extraction baseline](backend-extraction.md#selection-matrix)

## Enumeration and conservative selection

`scripts/test-ownership.ts` exports:

- `rootSuites(root)`: the same sorted, immediate, non-hidden `.test.ts` entries
  the existing shell glob supplies to Node. Helpers/nested fixtures are excluded.
- `suiteCatalog(suites, groups?)`: execution owners and diagnostics. Duplicate
  owners or group ids throw. Unknown suites receive the explicit `unclassified`
  fallback owner. Deleted catalog entries remain diagnostics until removed.
- `testPlan(root, requestedGroups?, groups?)`: a complete deduplicated suite list,
  or a requested group union. A catalog addition/deletion replaces any subset
  with the full discovered set and returns `fallback` diagnostics. Unknown group
  names, an empty group request, or an empty repository suite set fail closed.
- `affectedTestGroups(root, changedPathsOrNull, groups?)`: the plan `npm run affected:test` runs.
  The caller must supply the complete path change set, including both sides of
  renames, deletions, additions and any documented local changes. `null` means
  history/inputs are unavailable and selects everything. An empty array explicitly
  means no changes, returning no groups; do not pass an empty plan to the runner.

Execute a plan's `suites` once. When `fallback` is nonempty, command wiring must
invoke the full runner once rather than fan out the returned group ids: separate
group invocations would each detect catalog drift and repeat full execution.

Project dependencies come from the `project.json` graph. The audit checks
workspace edges against manifests and expands each group's transitive closure.
It follows imports, type references, re-exports and helper chains. Literal
dynamic imports, including `import(new URL("./file.ts", import.meta.url).href)`,
are checked without executing them. Public workspace subpaths and private
relative `dist/` imports resolve to source before builds exist. Suites that
load `src/application.ts` for application identity track that file and its
imports. A CLI-only edit reaches the suites exercising the CLI project.

Missing or unresolved imports, parse failures and graph drift select full
work. Computed imports require declared coverage of every production project.
The audit also flags Node filesystem imports in narrow suites and their
helpers unless the importing file is in `AUDITED_FILESYSTEM`. Review the actual
paths before adding an entry. Scratch fixture reads stay with their owners,
checkout inputs must be covered by the owner's project closure or global-input
rules, and arbitrary repository scans belong in architecture or build.

Architecture and build groups run on **every changed path**, including added or
deleted source files with no importers. `test/support/**`, `scripts/**`, project
configuration, root configuration/manifests, docs and unrecognized paths select
all groups. A new or deleted suite also selects all groups with diagnostics;
`test/test-ownership.test.ts` fails the full validation until its catalog is
updated. A newly imported cross-project dependency likewise requires updating
the group's declared projects. `npm run affected:test` (`scripts/tasks.ts`)
resolves the change set from Git and never passes an empty one: no changes
runs everything instead.

## Runner

First build packages with the existing workspace-link preflight. In an
environment that permits Node's test worker processes:

```sh
npm run build:packages && node --import tsx scripts/run-test-groups.ts --full
npm run build:packages && node --import tsx scripts/run-test-groups.ts --group package-agent-policy
node --import tsx scripts/run-test-groups.ts --group web --group web-http --list
node --import tsx scripts/run-test-groups.ts --full --list
```

`--list` prints the plan as JSON without executing tests. No flags defaults to
full execution. Repeat `--group` for a union; no suite runs twice. Diagnostics
use stderr, including any full fallback. The reusable
`runTestSuites(suites, { cwd })` in `scripts/test-runner.ts` runs one native
`node --import tsx --test <explicit files...>` process, with inherited stdio,
normal worker isolation and Node's default reporters/concurrency. It requires
an already prepared package build; command wiring must preserve the preflight
and prerequisite package builds rather than assuming compilation or links.

The runner waits for child `close`, preserves Node's numeric exit code, and
returns nonzero on launch error, unknown exit evidence or signal termination.
SIGINT/SIGTERM are forwarded to the entire POSIX test process group; cancellation
always returns 130/143 even if a worker handles the signal and exits zero.
After five seconds it escalates to SIGKILL; a second cancellation signal forces
that escalation immediately. Windows forwards signals to the immediate child;
the POSIX descendant cancellation fixture is skipped there. Inherited diagnostic
streams are not captured, truncated, parsed or filtered by the runner.

`test/test-runner.test.ts` checks lifecycle failures and cancellation in process.
`test/test-runner-process.test.ts` also checks actual Node worker isolation,
assertion diagnostics, numeric exits and POSIX descendant cancellation. Those
native worker fixtures, like the full suite, require an approved environment
outside Codex's no-network sandbox. Locally use `npm run typecheck`, then direct
`node --import tsx test/test-ownership.test.ts` and
`node --import tsx test/test-runner.test.ts`. Full validation remains Crane's
unchanged `npm run typecheck` and `npm test` checks.
