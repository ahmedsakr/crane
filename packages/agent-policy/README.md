# @crane/agent-policy

Crane's shared deny list, deterministic command guard and permission-rule
handling for operator actions and agent drivers. Import `ALWAYS_DENIED`,
`classifyToolCall`, `isAllowed`, `overlapsDenied`, and `suggestRules` from
`@crane/agent-policy`. The exports map hides implementation
paths, including `splitCommand`, which remains a best-effort rule helper rather
than a shell parser or security boundary.

The only runtime dependency is the rule grammar in `@crane/contracts/rules`.
The package compiles independently without Node or DOM ambient types. Driver
tool lists and CLI arguments stay in their drivers; Codex's guard remains its
sandbox rather than this deny list.

`classifyToolCall(call, context)` returns a `GuardVerdict` with a decision,
category, plain-language reason, suggested rules and whether an operator rule
can override it. `GuardContext`, `GuardCategory` and `GuardVerdict` are public
types. The caller supplies absolute POSIX paths; classification performs no I/O
or model calls and never changes `ALWAYS_DENIED`.

Hard categories apply in every access mode, even to operator-allowed commands.
`listed` otherwise passes to the existing permissions. `most` also denies
outward-facing commands unless the repository's rules cover them, and allows
other Bash calls. `auto` makes exactly the same denials as `most` but passes
everything else, so it cannot bypass Claude Code's model-based classifier.
Non-Bash file edits are checked for worktree and agent-configuration paths;
other non-Bash calls pass. The `job` profile also reserves task-branch Git
mutations for Crane.

The guard scans quoted strings, heredocs and substitutions as well as simple
commands, accepting false positives to catch concealed dangerous tokens. It is
best-effort protection against mistakes and prompt injection, not a boundary
against a determined adversary: it cannot resolve symlinks, evaluate shell
expansions or inspect arbitrary programs. The worktree, driver sandbox and
Crane-only merging remain the boundaries. This package supplies classification
only; driver hooks and access-setting plumbing are separate integrations.

Run `npm run build:packages` at the root to build every shared package in
dependency order. To rebuild only policy and the contracts it depends on, run
`npm run build -w @crane/agent-policy`. Normal build, typecheck, test, dev, and
source CLI commands build the packages first, and dev watches their sources.

This package is private and versioned with Crane. The root npm tarball bundles
its compiled JavaScript and declarations. The running factory watches every
package's `src/`, `package.json`, and `tsconfig.json` to notice when it needs
rebuilding and restarting, so new files need no registration.
