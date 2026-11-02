# Test selection

Outside the restricted agent sandbox, run `npm run typecheck` and `npm test`
separately and retain their exit statuses and failure diagnostics. Crane runs
both commands outside the agent sandbox for review and again for the merge
candidate. The local selection below does not change those configured checks,
skip tests in the full suite, or replace either gate.

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
| Source and package boundaries | `node --import tsx test/boundaries.test.ts` |
| Configured checks and factory-owned evidence | `node --import tsx test/checks.test.ts` |
| Token pricing and cost ledger | `node --import tsx test/codex-costs.test.ts` |
| Command lifecycle evidence, redaction, and recovery prompts | `node --import tsx test/command-evidence.test.ts` |
| Claude tool result metadata and diagnostic redaction | `node --import tsx test/claude-evidence.test.ts` |

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

## Checks delegated to Crane

In this known restricted sandbox, defer these checks without first attempting
them:

| Check | Reason |
| --- | --- |
| `npm test` | Uses a per-file subprocess runner and includes the fake-agent suites below. |
| Complete `test/limits.test.ts` | Claude Code stand-in CLI tests require piped child stdio. |
| Complete `test/drivers.test.ts` | Codex stand-in CLI tests require piped child stdio. |
| Complete `test/restart.test.ts` | Includes a Claude Code stand-in CLI resume test requiring piped child stdio. |
| `npm run screenshot` | Requires local servers and Chromium; follow the separate [visual review handoff](../README.md#visual-review-before-approval). |

The three mixed suites contain useful pure or simulated tests too, but running
the complete file directly still starts incompatible subprocess tests. Leave
those complete suites to the unchanged `npm test` review and merge checks.
Changes to driver streaming or resume behavior therefore need external test
results even when the local checks pass.

Claude tool events retain Bash commands up to 8192 characters in `data.command`
and correlate calls and results with `data.toolUseId`. Result events keep textual
content up to 8192 characters, stdout and stderr up to 4096 each, and available
error, exit-code, and interruption metadata in `data.result`. Each text field
has an explicit `truncated` flag. Credential redaction runs before truncation;
it is best effort, so diagnostic evidence still needs the same access controls
as task logs. Images and unrecognized SDK fields are not retained. Missing exit
codes stay null, and a lost stream never implies a successful command.

For example, report: “Typecheck and the direct permission tests passed. `npm
test`, including limits, drivers, and restart, was not run locally because of
the known piped-subprocess limitation; left to Crane's external review and
merge checks.” Distinguish checks actually attempted and failed or blocked
from checks deferred without an attempt. Do not invent an error message for a
deferred check, claim the full suite passed, or raise the known limitation as
a code finding. Crane records its own command, commit, logs, and exit status.

For unexpected failures, retain the actual diagnostics. Do not assume an
assertion failure or missing stream output proves a sandbox error. Never retry
a refused operation through another shell, interpreter, script, or rewritten
command, or change tests, scripts, production code, permissions, or sandbox
settings to bypass restrictions. Continue independent supported checks and
report the refused command's purpose and remaining validation. Checks not
covered by Crane's configured commands still require an explicit handoff;
screenshots and behavioral driver evaluation are not supplied by `npm test`.
