# TypeScript 7 spike

Status: **blocked before candidate installation**, 2026-11-02. No compiler
upgrade or performance improvement is delivered by this spike. Continue in an
environment with a writable npm cache and access to the required packages.
Do not treat the baseline below as evidence that TypeScript 7 works on Crane.

## Evidence

The starting commit was `4fba27df331819638aaee36616b506e6fef698ae`, running
Node v20.19.4 on Linux x64. Both the root and `web/package.json` pin
`typescript` to `~5.9.3`; changing only the root would leave web checking on
the old compiler. The package graph, workspace package scripts, and
`dev:packages` use `tsc -b`; all five packages emit declarations and keep their
incremental caches under `dist/`.

One unchanged baseline run of `/usr/bin/time -p npm run typecheck` passed
(exit 0): **73.17 seconds elapsed**, 107.64 seconds user CPU, 4.44 seconds
system CPU. This includes the package build, backend, tests/scripts, and web
checks, including web's contracts precheck. It is a single observation under
shared machine load, not a median or a comparison with the earlier task's
roughly 50-second individual checks. Cache state was not controlled.

`npm cache ls typescript` listed the 7.0.2 tarball, but this did not establish
that the candidate could be installed:

- `npm view --offline typescript@7.0.2 --json` failed with `ENOTCACHED` for
  registry metadata (exit 1).
- `npm pack --offline --ignore-scripts --pack-destination /tmp
  https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz` failed with
  `EROFS: read-only file system, mkdtemp
  '/home/ahmed/.npm/_cacache/tmp/hWXOoa'` (exit 226). Its purpose was to inspect
  the cached candidate without changing manifests. npm also could not write
  its logs under `/home/ahmed/.npm/_logs`.

Installation attempts stopped at that filesystem restriction. No alternate
cache, extraction script, or network download was attempted. Manifests,
lockfile, compiler configuration, and the boundary helper remain unchanged.
There is no TypeScript 7 timing, build, watch, declaration, or helper result.

## Compiler API decision

[Microsoft's TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)
confirms that 7.0 has no programmatic API, describes a different API planned
for 7.1, and supplies `@typescript/typescript6` for compatibility. That package
exposes `tsc6`, avoiding a collision with 7.0's `tsc`. The announcement also
describes build parallelism and a rewritten watcher; those are upstream
capabilities, not Crane validation results.

Crane's only direct compiler API import is `test/support/imports.ts`. Keep
its AST traversal rather than replacing boundary enforcement with regular
expressions. The proposed candidate uses `typescript` 7 for the CLI in both
workspaces, adds `@typescript/typescript6` at the root, and changes that
helper's default import to `@typescript/typescript6`. No alias is needed
because Crane owns this import. This compatibility arrangement still needs
installation, typechecking, and execution here.

## Continue the experiment

Time-box the continuation to 30 minutes. Make candidate edits only in an
isolated checkout; retain failures and stop if compatibility cannot be
established within the time box. Do not weaken configured checks to obtain
a speed result.

1. Before upgrading, repeat `/usr/bin/time -p npm run typecheck` three times
   sequentially. Save each complete log and exit status, keeping the same
   machine/load conditions as far as possible. Record compiler and Node
   versions. Distinguish the first package build from subsequent incremental
   runs; do not compare a cold run with a warm one.
2. Run `./node_modules/.bin/tsc -b tsconfig.packages.json --force --verbose`
   on 5.9.3 and save a copy of all five packages' emitted `.d.ts` files outside
   their output directories for comparison. Keep this forced-build timing
   separate from the normal typecheck timing.
3. Install the candidate at both dependency declarations, updating the
   lockfile through npm:

   ```sh
   npm install --save-dev 'typescript@~7.0.2' '@typescript/typescript6@^6.0.2'
   npm install --save-dev --workspace web 'typescript@~7.0.2'
   ```

   Change the helper import as described above. Check the root and web `tsc`
   resolution with `npm exec -- tsc --version` and
   `npm exec --workspace web -- tsc --version`; both must report 7.0.2.
   Confirm the compatibility package resolves and that lockfile entries cover
   the native platform dependencies. Complete all edits before validation.
4. Run `./node_modules/.bin/tsc -b tsconfig.packages.json --force --verbose`
   and await success. Confirm that every declared entry point still emits
   its `.js` and `.d.ts` files, inspect declaration differences against the
   saved baseline, and check that an immediate unforced graph build is up to
   date. Then repeat the same three timed `npm run typecheck` runs. Compare
   medians and report raw times and exit statuses, including any failures.
5. Run `npm run dev:packages` and wait for its initial successful build. In a
   separate terminal, temporarily add an exported type to contracts and
   import it from a dependent package to verify that both projects rebuild
   and declarations update. Introduce a type error in that consumer, observe
   a diagnostic, fix it, and observe recovery. Restore the temporary edits
   while the watcher is running and observe a final clean rebuild before
   stopping it. Record results; startup alone does not validate watch mode.
6. After restoring watch fixtures, run `npm run build:packages` successfully
   before the direct boundary checks:

   ```sh
   npm run build:packages && node --import tsx test/contracts.test.ts && node --import tsx test/boundaries.test.ts
   ```

   The contracts suite exercises the helper's static, dynamic, type-only,
   import-equals, and require references, including comments and strings.
   Run `npm run typecheck`, `npm run build`, and `npm test` separately in the
   approved environment and retain each exit status. The ordinary build
   covers backend transpilation and Vite, not just declaration emission.
7. Recommend adoption only if compatibility checks pass and measured gains
   justify the additional compatibility dependency. Otherwise retain 5.9.3
   and document the specific failure or lack of gain. A failed or blocked
   candidate check is not a completed migration.

The full `npm test` command is deferred locally to Crane's unchanged external
review and merge checks, as required by [sandbox test selection](testing.md#sandbox-test-selection).
Those checks on this documentation-only branch cannot establish candidate
compatibility: the compiler upgrade, watch exercise, declaration comparison,
and before/after measurements above remain outstanding.
