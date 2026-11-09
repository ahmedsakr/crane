# Test selection

The [TypeScript 7 spike](typescript-7-spike.md) records the compiler evaluation:
timings against 5.9.3, build, watch and declaration results, and why the import
helper uses `@babel/parser`.

Outside the restricted agent sandbox, run `npm run typecheck` and `npm test`
separately and retain their exit statuses and failure diagnostics. Crane runs
both commands outside the agent sandbox for review and again for the merge
candidate. The local selection below does not change those configured checks,
skip tests in the full suite, or replace either gate.

## Full and affected execution

npm installs and links workspaces using `package-lock.json`; Nx orchestrates
tasks installed by npm. `npm run typecheck` selects every project's typecheck
and prerequisite builds. `npm test` builds all eight packages then executes all
root suites once. Both retain full coverage and remain the factory defaults;
operator-configured checks, candidate evidence and sandbox deferrals are
unchanged. A local affected pass is development feedback, not full factory
validation or evidence that a different candidate passed.

```sh
# Compare two committed trees; HEAD must be checked out and clean.
npm run affected:typecheck -- --base main --head HEAD --list
npm run affected:typecheck -- --base main --head HEAD
npm run affected:test -- --base main --head HEAD
# Compare the base to disk, including staged/unstaged/deleted/untracked inputs.
npm run affected:typecheck -- --base main --working-tree --list
npm run affected:typecheck -- --base main --working-tree
npm run affected:test -- --base main --working-tree
```

Replace `main` with the known-good local commit that defines your intended
boundary. There is no default base, `HEAD~1`, fetch or merge-base calculation:
tree comparison includes changes present only on the base. Ignored untracked
files are excluded; renames count as both deletion and addition. Give exactly
one of `--head` or `--working-tree`; missing arguments are usage errors, not
fallbacks. `--list` prints selection/diagnostics without checking links,
building, testing or warming the task cache.

Unavailable local history (including a shallow checkout missing the base), a
self-comparison, no changes, a head not checked out or a dirty `--head` run
selects full work and reports why. Nothing silently fetches. Global config,
graph changes and unknown ownership also select full work. Typecheck expands
changed projects to dependent consumers; tests use audited ownership groups,
always adding architecture/build scans. Helpers, scripts, docs, new/deleted
suites and uncertain imports select every test group. Outside-project Markdown
is ignored by typecheck selection, but a change set with no typecheck input
still falls back fully. See [exact selection rules](nx.md#commands) and
[test ownership](test-groups.md#enumeration-and-conservative-selection).

## Cache controls

Nx uses only the ignored `.nx/` cache in each checkout, with no required daemon
or remote service. Cacheable tasks hash project files, transitive dependency
inputs, installed dependencies and shared globals: root manifests/lockfile,
root TypeScript config, Nx config, `.gitignore`, build/link/toolchain scripts,
Node/tool versions, platform/architecture, `NODE_OPTIONS` and `NODE_ENV`.
Checks' typecheck also includes `scripts/`. See [input definitions](nx.md#inputs-and-invalidation).
Package builds restore the complete `packages/<name>/dist/`, including
declarations and composite build info. Backend/web/checks typechecks cache
success with no emitted outputs. Package typecheck targets are no-ops after
builds. Tests and backend/web bundles never cache; affected tests still prepare
every package before running the selected suites.

In an authorized checkout with dependencies already installed:

```sh
# Reset Nx task cache and workspace metadata, not dependencies or tsc outputs.
# nx.json's relative cacheDirectory keeps a direct call on this checkout's .nx/.
node node_modules/nx/dist/bin/nx.js reset
# Also make package builds cold (removes their outputs and build info).
node_modules/.bin/tsc -b tsconfig.packages.json --clean
# Disable Nx task-cache reads/writes for a comparison; retain public preflights.
NX_SKIP_NX_CACHE=true npm run typecheck
NX_SKIP_NX_CACHE=true npm run affected:typecheck -- --base main --working-tree
NX_SKIP_NX_CACHE=true npm test
```

Resetting Nx does not make TypeScript cold: composite state remains in package
`dist/`. Conversely, removing `dist/` alone permits Nx to restore it. Do not
delete dependencies or outputs to diagnose a cache hit in a restricted sandbox.
If links or Nx are missing, retain the error and use normal `npm install` only
where authorized; never bypass the link check or substitute `npm ci --dry-run`.
Run `npm run build:packages` successfully before direct tests, even after a cache
reset. `NX_SKIP_NX_CACHE` does not force tsc to rebuild unchanged composites,
make socket tests sandbox-compatible, or authorize retrying a refused command.

## Benchmark protocol

Run measurements in an authorized disposable checkout with supported
installs, subprocesses and sockets. The protocol itself claims no speedup; the
final acceptance run's results, verdict and deviations from this protocol are
in [Measured results](nx.md#measured-results).
Keep installation outside task timing and record its separate duration for
fresh-worktree evaluation. Use the same candidate, dependencies, hardware,
environment, suite list and compiler options for each paired comparison.

Record commit/base/head, exact command, OS, CPU model/core count, RAM, load,
Node (`node --version`), npm (`npm --version`), Nx
(`node node_modules/nx/dist/bin/nx.js --version`) and installed compiler/bundler/tsx
versions (`node scripts/nx-toolchain.mjs`). Save unfiltered stdout/stderr and
the command tool's authoritative exit status separately for every run. On a
host with `/usr/bin/time`, prefix each command with `/usr/bin/time -p -o <file>`
for wall/user/system seconds; never pipe timing output through a filter.
`/usr/bin/time` reads the wall clock, which a clock step can inflate (one
acceptance run measured 504 s for a 64.6 s suite), so also record a monotonic
duration, such as `performance.now()` around the command or the test runner's
`duration_ms`, and investigate any run where the two disagree.

For the backend extraction, `scripts/benchmark-tasks.ts` runs this protocol's
full, warm, cold, uncached and changed-project phases over fixed CLI, HTTP,
factory, storage, runtime, web and shared-contract edits; see
[Backend extraction](backend-extraction.md#benchmark-protocol) for its cases,
records, baseline and success targets.

Compare these workloads separately:

| Workload | Baseline without Nx | Nx |
| --- | --- | --- |
| Full typecheck | `npm run build:packages`, then local `tsc -p tsconfig.json --noEmit`, `tsc -p tsconfig.test.json`, and web's local `tsc -p tsconfig.json --noEmit` from `web/` | `npm run typecheck` |
| Full tests | `npm run build:packages`, then `node --import tsx scripts/run-test-groups.ts --full` | `npm test` |
| Selected typechecks | Link preflight and package prerequisites, then the exact compiler commands for the projects in `--list`, in dependency order | affected typecheck with the same boundary |
| Selected tests | `npm run build:packages`, then runner with repeated `--group` for the exact selected group union | affected test with the same boundary |

Use `node_modules/.bin/tsc` at root and `../node_modules/.bin/tsc` from web
for baseline compiler calls; do not use downloading `npx`. Package typecheck
is its composite build, not an additional compiler invocation. Preserve the
link preflight and all prerequisite builds. For multi-command baselines, time
the complete sequence with prerequisites joined by `&&`, retain failures,
and also record component times. Derive selected compiler commands and package
prerequisites from the candidate's `project.json` files; do not omit checks'
test/script compilation or run a suite twice. Compare full baseline to full Nx
to isolate orchestration effects, and identical selected work to selected Nx;
report full-versus-affected savings separately as reduced work, not cache speed.

Use independently prepared copies at the same candidate for each arm so one
arm cannot warm the other's outputs. Run at least five repetitions per phase,
alternate arm order, and report every result plus median and range:

1. **Cold:** in disposable, authorized copies only, remove generated package
   `dist/` outputs and reset Nx before each run. Record precisely which state
   was cleared. Keep installed dependencies identical; OS filesystem cache
   need not be cold, but disclose it. If cleanup is refused, do not retry;
   label the cold measurement unavailable.
2. **Warm:** repeat unchanged immediately without reset or edits. Capture
   selected targets, executed targets, Nx hits/total cacheable tasks and suite
   count from complete logs. Tests must execute again; no test-result hits.
3. **Changed project:** from warmed copies, apply the same recorded valid
   source patch to each arm, then select `--working-tree` against the same
   known-good base. Save the patch and `--list` output before timing execution.
   Restore independently prepared state between cases; do not accumulate edits.
4. **Uncached:** repeat with `NX_SKIP_NX_CACHE=true` and equivalent tsc state
   on both arms. Separately time `--list`, the link preflight and an up-to-date
   baseline build to expose selection, hashing and startup overhead. List-only
   timing omits Nx startup and is not a substitute for a warm execution timing.

Exercise each boundary below for both affected commands, retaining selections
and fallback reasons rather than assuming a leaf implies a single test:

| Case | Reproducible change/boundary | Expected scope to verify |
| --- | --- | --- |
| Contracts | Valid source patch under `packages/contracts/src/` | Contracts and transitive consumers; test dependency closure plus scans |
| Leaf package | Valid patch under `packages/worktree-deps/src/` | Package, backend and checks typechecks; relevant test groups plus scans |
| Backend | Valid patch under `src/` | Backend and checks typechecks; backend consumers and scans |
| Web | Valid patch under `web/src/` | Web and checks typechecks; web consumers and scans |
| Tests/helpers | Patch a suite, then separately `test/support/` | Suite owner plus scans; helpers select all tests, checks typecheck |
| Lockfile/config | Valid lockfile change, then separately root `nx.json` or tsconfig | Full fallback; prepare dependencies again if lockfile changes |
| Missing base | `--base refs/heads/benchmark-missing-base --head HEAD` with that ref confirmed absent | Explicit unavailable-history diagnostic and full fallback |

Also preview staged, unstaged, deleted, renamed and non-ignored untracked cases,
dirty `--head`, identical base/head and no-change working trees. Record whether
each selects fully and why. Missing-base execution must use the same full
workload as the baseline; do not count it as an affected saving.

Publish rows with: case/patch, phase/repetition, arm, boundary, selected
projects/groups/suites, actual executed tasks, cache hits/eligible tasks,
wall/user/system time, exit status and log path. Include hardware/tool metadata
with the table. Report regressions and overhead as well as savings; mark blocked
or unmeasured cases explicitly. Fresh-worktree installs, Node compatibility,
cache restoration and sandbox-incompatible suites remain separate verification
obligations, not conclusions from warm timings.

## Validation order

Before each editing agent attempt (including resumed sessions, merge resolution,
and check fixes), the trusted runner creates an ignored `.crane-logs-<suffix>/`
directory inside the isolated worktree. The fresh or resume prompt supplies its
exact absolute path. Use that existing directory with a shell-quoted path when
saving command output; no placeholder or outside-worktree log destination is
needed. The directory ignores its own contents even in repositories without
Crane ignore rules, and is removed with the worktree. Investigate-only runs do
not create a directory or gain write permission. This preparation does not
change command permissions or authorize retrying a refused command.

Log text and shell-echoed `exit=0` do not establish authoritative process metadata.
If the command tool provides no exit status, report the process outcome as unknown.

Run `git diff --check` as a separate command from informational Git commands
such as `git status`, `git diff --stat`, or diff inspection, and retain its own
exit status. Do not combine them as `git diff --check; git status`: the recorded
exit status belongs to the final command and cannot establish that whitespace
validation passed. This is an evidence requirement, not evidence that any
whitespace error occurred.

Finish all relevant edits before starting builds, typechecks, or tests, and do
not edit their inputs while they run. Workspace packages export compiled
`dist` files: for example, `test/report.test.ts` imports `@crane/agent-protocol`,
so running it directly after editing `packages/agent-protocol/src/report.ts`
can exercise the previous parser unless the package is rebuilt first.

After the final relevant edit, await a successful `npm run build:packages`
(or the package build included in a successful `npm run typecheck`) before
starting dependent direct tests. Run these steps sequentially; starting a
build in the background does not satisfy the prerequisite. Stop dependent
checks if the build fails or is blocked.

Further edits invalidate affected local build, typecheck, and test results.
Rebuild changed packages and rerun dependent checks before reporting a pass
for the final code. Treat checks that overlapped relevant edits as invalid
too: their results do not establish which version of the inputs was checked.

## Sandbox test selection

In Codex's no-network sandbox, start with `npm run typecheck`. It builds the
workspace packages and checks backend, tests, scripts, and web. If it cannot
run, retain the error and leave it to Crane's external check. Before running
source tests directly, packages must have built successfully. If typecheck was
not selected, first run `npm run build:packages`. Stop dependent checks if the
prerequisite build fails or is blocked; do not retry a refused build separately.

Choose relevant checks from this supported selection. Run each command
separately, without output-filtering pipelines; these files do not launch fake
agent CLIs or listen on ports.

| Scope | Direct command |
| --- | --- |
| Permission rules and deny list | `node --import tsx test/agent-policy.test.ts` |
| Agent report parsing | `node --import tsx test/report.test.ts` |
| Source, package and responsibility boundaries | `node --import tsx test/boundaries.test.ts` |
| Code-shape limits | `node --import tsx test/code-shape.test.ts` |
| Configured checks and factory-owned evidence | `node --import tsx test/checks.test.ts` |
| Token pricing and cost ledger | `node --import tsx test/codex-costs.test.ts` |
| Command lifecycle evidence, redaction, and recovery prompts | `node --import tsx test/command-evidence.test.ts` |
| Refusal history across editing, validation, fresh sessions and retries | `node --import tsx test/refusal-context.test.ts` |
| Claude tool result metadata and diagnostic redaction | `node --import tsx test/claude-evidence.test.ts` |
| Dependency install progress, diagnostic bounds, and process outcomes (in-process fixtures) | `node --import tsx test/install-process.test.ts` |
| Credential redaction corpus for every diagnostic consumer | `node --import tsx test/diagnostics.test.ts` |

This is a conservative starting selection, not an exhaustive list of runnable
files. For other task-relevant tests, inspect their setup and dependencies
before selecting a direct-file diagnostic. A direct invocation avoids the
per-file subprocess wrapper used by `node --test`; it does not remove child
processes or socket operations inside the tests themselves. Do not use a
wildcard to run every test file directly.

## Shared test helpers

Keep repo-local helpers in `test/support/`; the `test/*.test.ts` runner glob
excludes them, and `tsconfig.test.json` typechecks them. `git.ts` exports `sh`
for git commands with a fixed test identity and signing disabled.
`fake-agents.ts` holds the Claude event-replay, Claude lost-session, and Codex
CLI fixtures. Add stream fixture changes there so callers share the same
protocol examples. Keep suite-specific setup in its test file until another
suite needs the same behavior; these helpers do not need a workspace package.

`fixtures.ts` registers temporary roots with test teardown immediately, so
setup errors and failed assertions cannot skip removal. Register factories and
stores with `onFixtureCleanup` as soon as they exist: callbacks run in reverse
order before roots are removed. The returned callback can stop a factory early
without running its teardown twice. `testHome` also restores `CRANE_HOME`.
These fixtures are always removed, including on failure; debugging must not
retain them implicitly. Cleanup touches only roots allocated by that test.

## CLI output tests

For CLI output tests, start with the existing in-process harness in
[`test/cli.test.ts`](../test/cli.test.ts) before setting up a separately seeded
demo home. Its `setup()` creates a `Store(":memory:")`, and its `crane()` helper
calls `runCli` with that store, captures console output with ANSI colors removed,
and intercepts exit codes. Extend these tests to assert output, errors, and
store changes; the follow-up `show` test is an example of checking displayed
task and finding links. The helper temporarily replaces console methods and
`process.exit`, so keep its calls sequential.

After the successful package build described above, run this file directly with
`node --import tsx test/cli.test.ts`. It needs no seeded `CRANE_HOME` or separate
CLI process. It does **not** validate process startup or persistent-home
behavior; those still need separate validation when relevant. This harness
does not broaden permissions or replace incomplete manual CLI validation.

## Screenshot comparisons

Plain `npm run screenshot` boots a live demo: new ids, dates relative to now,
random usage figures, and simulated agents working while it captures. Reduced
motion can't make that repeatable, so two captures of one build differ wherever
a view shows any of it: in one measurement with identical framing, 2,498 pixels
on the site and 19,574 on analytics, against none for the fixture. A view that
happens to match, as `/tasks` did, proves nothing about the next one. To compare
images, use the fixture and a matrix:

```sh
npm run build -w web &&
npm run screenshot:matrix -- scripts/matrices/site.json --out-dir .crane/screenshots/before

# Then on the changed build:
npm run build -w web &&
npm run screenshot:matrix -- scripts/matrices/site.json --out-dir .crane/screenshots/after --baseline .crane/screenshots/before
```

**The fixture** (`npm run screenshot -- <path> --fixture`) pins everything the
demo leaves open:

| Pinned | How |
| --- | --- |
| Ids and seeded data | `scripts/fixture/preload.ts` seeds `Math.random` and `randomBytes` for `seed-demo.ts`; demo commits get fixed dates |
| Displayed time | One stopped clock in the seed, the server and the page, in UTC and `en-US` |
| Factory state | `scripts/fixture/serve.ts` serves the real API with no factory: always running, one task held working, the rest held queued |
| Paths | API responses show `/fixture/home` and `/fixture/crane`, not the temp home and checkout |
| Motion | Reduced motion unless you set `prefers-reduced-motion`, with CSS animation, transitions and the caret off |
| Readiness | Capture waits for three matching frames and fails after 10 seconds of change |

It only runs in a home it just created under the temp directory; the preload
exits for any other `CRANE_HOME`, so none of this can reach a real home or the
factory. Production code has no fixture mode. It refuses a `web/dist` older than
its source, and `--url`, whose data it can't pin.

**A matrix** names one `target` to crop to, one `ready` selector, and one `scroll`
position, across its `sizes` and `media`. Use `{ "center": ".site-canvas" }` when
the target's offset changes with the layout, or `{ "selector": "html", "top": 0 }`
for a fixed position. A target outside the viewport fails instead of capturing
something else.

**Check repeats first.** Each cell is captured twice from fresh fixtures. A cell
that differs from itself is reported as not repeatable, never compared, and makes
the command exit 1: its differences can't be told apart from noise. Differences
from the baseline are results, so they exit 0.

**Metadata stays with the image.** Each fixture PNG carries a text chunk with the
fixture version, framing, build and data hashes and browser version, so it survives
being attached to a task under a new name. Read it with
`npm run screenshot:matrix -- --inspect <file.png>`. Images only compare when their
fixture and framing match. Bump `FIXTURE.version` when a change to the fixture or
`seed-demo.ts` moves pixels.

The fixture doesn't pin the browser or the machine's font rendering. Compare
images from one machine and browser; the bundled UI fonts are the same everywhere,
but the `browser` field shows when two images came from different versions.

## Multi-operator remote access

`test/auth-e2e.test.ts` uses the same Node HTTP adapter as `serve`, bound to
`127.0.0.1:0`, with a disposable persistent Crane home. It bootstraps Robin
through `runCli`, sends the public Host and HTTPS proxy headers over real
sockets, onboards Kai, checks the complete protected/admin route tables,
races an approval against a decline, and verifies attributed events, PNG
attachments, live SSE delivery, revocation and CLI sign-out. Its secret scan
includes every home file, SQLite's WAL and captured CLI/API log output.
This verifies the proxy-to-Crane hop; it does not obtain a certificate or
exercise an actual EC2 security group or TLS terminator.

In an environment that allows sockets and git subprocesses, run:

```sh
npm run build:packages && node --import tsx test/auth-e2e.test.ts
```

The separate `node --import tsx test/auth-docs.test.ts` check exercises the
README's command help and scans secrets in a persistent home without sockets.
The broader command behavior is covered by `test/cli-operators.test.ts` and
`test/api-exposure.test.ts`. A passing subset does not establish the socket
suite's result. Codex's restricted sandbox defers the socket suite to Crane's
external `npm test` check, and defers screenshots without attempting a server.

Optional visual verification in an approved environment: the commands below
use the existing screenshot tool and throwaway demo homes. They exercise
sign-in as Robin, the invite form, joining as Kai, an attributed task decision,
and signing out, at all three required sizes. The task is scheduled far ahead
so the demo factory cannot claim it before Kai cancels it; its page subscribes
to live events while queued. These captures supplement the approval race in
the socket test. The four captures per viewport fit Crane's 12-image limit.
These demo credentials must never be used on a real factory.

```sh
npm run build -w web &&
for viewport in 1280x800 1280x600 390x844; do
  npm run screenshot -- /operators --size "$viewport" \
    --operator robin --password demo-password-123 \
    --wait-for '.sign-in-form' \
    --click 'input[name="username"]' --type robin \
    --click 'input[name="password"]' --type demo-password-123 \
    --click '.sign-in-submit' --wait-for '.page-head .btn-primary' \
    --click '.page-head .btn-primary' \
    --click '.sheet-pane input[name="name"]' --type Kai \
    --shot ".crane/screenshots/invite-$viewport.png" \
    --click '.sheet-pane-foot .btn-primary' --wait-for '.operator-link' \
    --eval 'location.assign(document.querySelector(".operator-link").value)' \
    --wait-for 'input[name="confirm"]' \
    --click 'input[name="username"]' --type kai \
    --click 'input[name="password"]' --type kai-demo-password-123 \
    --click 'input[name="confirm"]' --type kai-demo-password-123 \
    --shot ".crane/screenshots/join-$viewport.png" \
    --click '.sign-in-submit' --wait-for '.account-button[aria-label="Account: Kai"]' \
    --eval 'fetch("/api/tasks", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({kind:"factory_feature", title:"Verify operator attribution", brief:"Disposable screenshot task", autonomy:"observe", scheduledAt:"2099-01-01T00:00:00.000Z"})}).then(async r => {if (!r.ok) throw new Error(await r.text()); const task = await r.json(); location.assign("/tasks/" + task.id)})' \
    --wait-for '.detail-title' \
    --eval 'Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Cancel task").click()' \
    --wait-for '.tl-operator .muted' --scroll-to '.tl-operator' \
    --shot ".crane/screenshots/attributed-task-$viewport.png" \
    --click '.account-button' --click '[role="menuitem"]:last-child' \
    --wait-for '.sign-in-form' \
    --out ".crane/screenshots/signed-out-$viewport.png" || exit "$?"
done
```

Open every resulting PNG to inspect clipping, overflow, form scrolling, the
actor name and the signed-out screen. Capturing images alone does not record
an operator visual decision; current task pre-approval and candidate coverage
still govern whether a separate decision is needed.

## Checks delegated to Crane

In this known restricted sandbox, defer these checks without first attempting
them:

| Check | Reason |
| --- | --- |
| `npm test` | Uses a per-file subprocess runner and includes the fake-agent suites below. |
| Complete `test/limits.test.ts` | Claude Code stand-in CLI tests require piped child stdio. |
| Complete `test/drivers.test.ts` | Codex stand-in CLI tests require piped child stdio. |
| Complete `test/restart.test.ts` | Includes a Claude Code stand-in CLI resume test requiring piped child stdio. |
| `npm run screenshot` and `npm run screenshot:matrix` | Require local servers and Chromium; follow the separate [visual review handoff](../README.md#visual-review-before-approval). |

The three mixed suites contain useful pure or simulated tests too, but running
the complete file directly still starts incompatible subprocess tests. Leave
those complete suites to the unchanged `npm test` review and merge checks.
Changes to driver streaming or resume behavior therefore need external test
results even when the local checks pass.

Dependency installs keep their ten-minute limit and emit progress every 30
seconds even when the package manager is silent. Each note identifies the
command and elapsed time, with the last four complete lines per stdout/stderr
stream (512 characters each), byte counts, and time since the last output.
Omitted output is marked; lines exceeding 8192 characters are discarded in
full, and a partial line is retained only for
redaction when completed or when the process closes. Credentials are redacted
before line truncation, including URL credentials/query strings, common secret
assignments, authorization headers, and private-key blocks. This is best effort;
install diagnostics need the same access controls as task logs. Completion and
failure notes distinguish exit codes, signals, cancellation, timeout, and spawn
errors. These tails can guide investigation but do not establish whether a slow
install was caused by downloads, lifecycle scripts, or resource contention.

Installs and configured checks each run in their own process group. A timeout or
cancellation sends that group SIGTERM, then SIGKILL three seconds later, so a
hung lifecycle script or test runner can't outlive it or hold a crew slot. A
check that was cancelled or stopped with the factory records no validation run,
since it says nothing about the candidate; one that hits its ten-minute limit is
recorded as `blocked`. Check logs keep their last 1 MiB of characters, with the
omission marked.

When configured check output reports ENOSPC, SQLITE_FULL, no space left on
device, or database or disk is full, the trusted check runner takes one
read-only filesystem snapshot at the first detected error. It records available,
free and total bytes and free and total inodes for the check directory, OS temp
directory and Crane home, or an error code for unavailable paths. Up to four
redacted error lines survive ordinary log-tail truncation. This bounded evidence
is appended to the check's validation logs without changing its exit status or
verdict. It does not identify which files caused exhaustion, scan other tasks,
delete files, or expand agent permissions.

Claude tool events retain Bash commands up to 8192 characters in `data.command`
and correlate calls and results with `data.toolUseId`. Result events keep textual
content up to 8192 characters, stdout and stderr up to 4096 each, and available
error, exit-code, and interruption metadata in `data.result`. Each text field
has an explicit `truncated` flag. Credential redaction runs before truncation;
it is best effort, so diagnostic evidence still needs the same access controls
as task logs. Images and unrecognized SDK fields are not retained. Missing exit
codes stay null, and a lost stream never implies a successful command.

The [SDK result schema](https://code.claude.com/docs/en/agent-sdk/typescript#tool-output-types)
types `tool_use_result` as unknown and documents Bash output with stdout, stderr,
and interruption metadata, but no process exit code. Crane accepts numeric
`exit_code` / `exitCode` fields when supplied and records their source; it never
derives exit 0 from `is_error=false`, TAP counts, or text such as “Exit code 0”.
Claude reports receive a driver-owned validation qualification listing commands
without exit evidence (up to five bounded examples), including results lost when
the stream closes. It describes only that invocation, does not override the
agent's implementation completion, and does not replace or invalidate independent
review and merge checks. These additions extend the existing command-details and
diagnostic-outcomes tracking rather than introducing a second evidence store.

Because the Bash tool can't supply an exit code, Claude runs that may write are
briefed to run checks through Crane's check handle, the compiled
`packages/agent-drivers/dist/check-handle.js` (`node <path> run <name> --
<command>`, then `node <path> wait <name>` for one started in the background).
`run` writes the check's output to `.crane/checks/<name>.log` and a record with
the process's own exit code to `<name>.json` (the directory ignores itself),
and exits with that code. `wait` blocks for at most 300 seconds by default and
540 with `--timeout`, prints progress, and exits with the check's code, 75 if
it is still running, or 70 when its runner stopped without a result, which
stays unknown. This replaces redirecting to a log, echoing `EXIT=$?`, and
polling TAP files. At the end of the invocation the driver reads the records
of checks started during it and appends their outcomes to the report summary,
next to the missing-exit qualification. The records live in the worktree, so
they are local agent evidence like the rest of this section, not a
replacement for Crane's review and merge checks. Investigate-only runs and
Codex, whose command events carry exit codes, aren't briefed on it.

For example, report: “Typecheck and the direct permission tests passed. `npm
test`, including limits, drivers, and restart, was not run locally because of
the known piped-subprocess limitation; left to Crane's external review and
merge checks.” Distinguish checks actually attempted and failed or blocked
from checks deferred without an attempt. Do not invent an error message for a
deferred check, claim the full suite passed, or raise the known limitation as
a code finding. Crane records its own command, commit, logs, and exit status.

For unexpected failures, retain the actual diagnostics. Do not assume an
assertion failure or missing stream output proves a sandbox error. Never retry
a refused operation through another shell, interpreter, script, rewritten
command, or equivalent native-tool call (including Grep, Glob, or Read), or change tests, scripts, production code, permissions, or sandbox
settings to bypass restrictions. Continue independent supported checks and
report the refused command's purpose and remaining validation. Checks not
covered by Crane's configured commands still require an explicit handoff;
screenshots and behavioral driver evaluation are not supplied by `npm test`.

The actionable-refusal evidence and compound-command guidance from t-h75934
also apply across phases. Each agent attempt receives up to 40 recent persisted
`blocked` events for its task, independently of command lifecycle history;
fresh, resumed, conflict-edit, conflict-validation, and check-fix prompts carry
a redacted, bounded snapshot. Missing refusal reasons remain unknown; suggested
permission rules do not explain a refusal. If a marker scan is refused, leave
it unavailable and report its purpose and remaining validation for operator
review rather than replacing it with a native search tool. No permissions are
broadened by this handoff, and older refusals may be omitted from the snapshot.
