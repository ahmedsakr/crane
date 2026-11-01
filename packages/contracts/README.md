# @crane/contracts

Internal, dependency-free domain types, HTTP response shapes, labels, and pure
presentation helpers used by Crane's dashboard, server, CLI, store, and drivers.

Import from `@crane/contracts`. The explicit exports in `src/index.ts` are the
public API; implementation files are hidden by the package exports map. Backend
permission handling imports `parseRule` from `@crane/contracts/rules` to reuse
the grammar. Rule matching, suggestions, and enforcement stay in the backend.

No Node modules, SQLite, React, factory implementation, or external runtime
dependencies belong here. Boundary tests and a separate TypeScript config
without Node/DOM ambient types check that constraint.

`npm run build:contracts` at the repository root emits ESM and declarations into
`dist/`. Normal build, test, typecheck, and dev commands build it first, including
standalone web builds used by dashboard publishing. `npm run dev` watches shared
sources too. After a fresh install, build contracts before running source scripts
directly (for example, `node --import tsx scripts/seed-demo.ts`).

This package is private and versioned with Crane. Crane declares and bundles it
as a dependency in its npm tarball; it does not need a separate registry release.
Do not import another workspace's source or use TypeScript path aliases to bypass
the exports map. Update `SHARED_SOURCES` in `src/core/webbuild.ts` when adding inputs.
