# @crane/agent-policy

Crane's shared deny list and permission-rule handling for operator actions and
agent drivers. Import `ALWAYS_DENIED`, `isAllowed`, `overlapsDenied`, and
`suggestRules` from `@crane/agent-policy`. The exports map hides implementation
paths, including `splitCommand`, which remains a best-effort rule helper rather
than a shell parser or security boundary.

The only runtime dependency is the rule grammar in `@crane/contracts/rules`.
The package compiles independently without Node or DOM ambient types. Driver
tool lists and CLI arguments stay in their drivers; Codex's guard remains its
sandbox rather than this deny list.

Run `npm run build:packages` at the root to build contracts, agent protocol,
and agent policy in order. To rebuild only policy after contracts are built,
run `npm run build:agent-policy`. Normal build, typecheck, test, dev, and source
CLI commands build the packages first, and dev watches their sources.

This package is private and versioned with Crane. The root npm tarball bundles
its compiled JavaScript and declarations. Update `AGENT_POLICY_SOURCES` in
`src/core/webbuild.ts` when adding build inputs so the running factory notices
when it needs rebuilding and restarting.
