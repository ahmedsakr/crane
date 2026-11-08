# Test selection

The [TypeScript 7 spike](typescript-7-spike.md) records the compiler evaluation:
timings against 5.9.3, build, watch and declaration results, and why the import
helper uses `@babel/parser`.

Outside the restricted agent sandbox, run `npm run typecheck` and `npm test`
separately and retain their exit statuses and failure diagnostics. Crane runs
both commands outside the agent sandbox for review and again for the merge
candidate. The local selection below does not change those configured checks,
skip tests in the full suite, or replace either gate.

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
