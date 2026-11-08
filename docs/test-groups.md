# Root test ownership and runner interface

This layer publishes ownership and execution interfaces. `npm test` builds the
packages through Nx and runs every root suite with this runner, and
`npm run affected:test` runs the suites `affectedTestGroups` selects; see
[Commands](nx.md#commands). There is no test-result cache.

`scripts/test-groups.ts` assigns every immediate `test/*.test.ts` suite exactly
once. Group ids are stable interfaces for `scripts/tasks.ts`:

| Group | Scope and dependencies |
| --- | --- |
| `package-contracts` | Shared helper parity; contracts, protocol and private driver sources |
| `package-agent-protocol` | Report parsing; protocol and contracts |
| `package-agent-policy` | Permission rules; policy and contracts |
| `package-agent-drivers` | Driver streams, hooks and process helpers; drivers and its package dependencies |
| `package-diagnostics` | Redaction and both consumers; diagnostics, drivers and worktree-deps |
| `package-worktree-deps` | Dependency installation, package-source scans and elapsed parity; all projects for computed export probes |
| `backend` | Backend/integration suites; backend and web (parity helpers), including their dependencies |
| `web` | UI helpers, rendering and API parity; web and backend, including their dependencies |
| `architecture` | Repository-wide source shape, boundaries, manifests, graph and ownership scans |
| `build` | Repository-wide build ordering, workspace links, dashboard staleness, screenshots and runner contracts |

An execution owner need not be the only project a suite imports. For example,
diagnostics tests read private driver and install-process sources. Backend and
web integration groups intentionally overlap in *inputs*, never in execution.
The contracts suite is owned by architecture because it scans every package,
the web tree and root manifests. It is not just a contracts unit suite.

These groups are coarse. `backend` holds 71 of the 118 suites and its closure
covers every project, so any package, backend or web edit still selects 105 to
118 suites; only an edit confined to root suites narrows much. The measured
effect is in [Measured results](nx.md#measured-results).

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

Project dependencies come from the merged `project.json` graph, including its
transitive edges. The import audit uses `test/support/imports.ts` to check named
imports, re-exports and helper chains, public package subpaths and private
package source imports (`.js` specifiers resolve to `.ts` source). Missing inputs,
parse failures or dependency drift cause full selection. Computed imports require
declared coverage of every production project; otherwise selection falls back
fully. This audit supplements explicit ownership: arbitrary filesystem reads
cannot define reliable ownership by themselves.

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
node --import tsx scripts/run-test-groups.ts --group web --group backend --list
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
