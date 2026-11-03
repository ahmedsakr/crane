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

Run `npm run build:packages` at the root to build every shared package in
dependency order. To rebuild only policy and the contracts it depends on, run
`npm run build -w @crane/agent-policy`. Normal build, typecheck, test, dev, and
source CLI commands build the packages first, and dev watches their sources.

This package is private and versioned with Crane. The root npm tarball bundles
its compiled JavaScript and declarations. The running factory watches every
package's `src/`, `package.json`, and `tsconfig.json` to notice when it needs
rebuilding and restarting, so new files need no registration.
