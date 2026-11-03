# TypeScript 7 spike

Status: **evaluated, adoption recommended**, 2026-11-03. Crane moves from
`typescript` 5.9.3 to 7.0.2 in both the root and `web`. No `tsconfig` or
application source changed. The import helper in `test/support/imports.ts`
moved from the compiler API to `@babel/parser`.

## Timings

Measured on Node v20.19.4, npm 9.2.0, Linux x64, with 4 CPUs and 3.3 GB of
memory, starting from `38e2103`. The machine was running other factory tasks,
with a load average of about 5 to 6 when last sampled. Load wasn't controlled,
so user CPU is the fairer comparison. Each row was timed with the shell's `time`.

| Measurement | 5.9.3 elapsed | 7.0.2 elapsed | 5.9.3 user CPU | 7.0.2 user CPU |
| --- | --- | --- | --- | --- |
| `npm run typecheck`, run 1 | 91.23 s | 23.60 s | 138.49 s | 30.26 s |
| `npm run typecheck`, run 2 | 97.87 s | 26.95 s | 125.79 s | 31.16 s |
| `npm run typecheck`, run 3 | 96.93 s | 20.00 s | 129.86 s | 25.71 s |
| **Median** | **96.93 s** | **23.60 s** | **129.86 s** | **30.26 s** |
| `tsc -b tsconfig.packages.json --force` | 30.11 s | 2.61 s | 50.99 s | 5.72 s |

The typecheck median is about 4 times faster, and the forced package build about
11 times faster. A later 7.0.2 typecheck took 11.92 s, which shows how much the
shared load moves these numbers.

The compiler is no longer most of `npm run typecheck`. Run directly, the three
checking stages took 0.91 s (backend), 1.59 s (tests and scripts, 314 files,
156 MB by `--extendedDiagnostics`), and 1.22 s (web), or 3.72 s together. The
rest of the script's time wasn't broken down, but it includes three nested
`npm run` starts: `build:packages`, `typecheck -w web`, and web's `pretypecheck`
running `build -w @crane/contracts`.

Two other attempts at a 5.9.3 typecheck ended with exit 137 and gave no timing.
Each time the run was interrupted and later resumed, but the cause of the kill,
including any part played by memory pressure, wasn't established. Run 1 on 5.9.3
was the first in this checkout, so its cache state differs from runs 2 and 3.

## Compatibility

| Check | Result |
| --- | --- |
| Clean install with `npm ci` | Passed; root and web `tsc --version` both report 7.0.2 |
| Lockfile platform coverage | All 20 native `@typescript/typescript-*` packages are listed |
| Build over a 5.9.3 cache | Rebuilds, naming the version mismatch as the reason |
| Unforced build after a forced build | Every project reports up to date |
| Emitted files, 5.9.3 against 7.0.2 | 51 of 52 `.js` and `.d.ts` files are identical |
| `tsc -b --watch` through `npm run dev:packages` | Passed: see below |
| Deliberate errors in backend, test and web projects | Each reports both `TS2322` and `TS6133` and exits 1 |
| `npm run build` | Passed in 4.84 s |
| `test/contracts.test.ts`, `test/boundaries.test.ts` | Passed, 15 and 13 tests |
| `npm run typecheck`, `npm test` | Passed; the suite has 469 tests |

The one emitted difference is
`packages/agent-drivers/dist/claude-evidence.d.ts`: an inferred return type lists
the same properties in a different order. It means the same thing, and the file
isn't part of the package's public entry point. Other inferred object types may
reorder the same way, so don't compare declaration text across compilers.

For watch mode, a new type exported from contracts and used in `agent-protocol`
rebuilt both projects and updated their declarations. A type error in the
consumer was reported within a second, and fixing it recovered. Restoring the
edits with the watcher running gave a clean rebuild. Each edit caused a few
extra rebuild cycles with 0 errors, and the watcher then stayed idle.

Not checked: other platforms' native binaries, and editors. `typescript` 7's only
bin is `tsc`, so an editor set to use the workspace TypeScript may need a new
setting. The repository has no shared editor configuration.

## Compiler API decision

[Microsoft's TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)
says 7.0 has no programmatic API, that a different API is planned for 7.1, and
offers `@typescript/typescript6` for compatibility.

**Don't use `@typescript/typescript6` here.** Installed beside `typescript@~7.0.2`,
its dependency `@typescript/old` (`npm:typescript@^6`, resolved to 6.0.3) owns
`node_modules/.bin/tsc`, which links to `../@typescript/old/bin/tsc`. There's no
error, so every script would keep running the old compiler and the upgrade would
look finished with no speedup. An earlier plan in this file proposed that
package; the probe disproved it. The test `build: tsc is TypeScript 7 and nothing
else in the tree can take over its bin` now fails if the lockfile gains another
`tsc` provider, or if root and web declare different versions.

`test/support/imports.ts` keeps walking a syntax tree rather than matching
patterns, now through `@babel/parser`. It stays on Babel 7 because Babel 8's
parser requires Node `^22.18.0 || >=24.11.0`, above Crane's `>=20.19`.
Before the change, the old helper's output was recorded for all 147 tracked
source files (882 references). The Babel helper matches on 146 files, and the
remaining difference is the helper's own import of `@babel/parser`.

Babel throws on a syntax error where the compiler API returned a partial tree, so
the helper now fails loudly on a file it can't parse.

## Landing it

Merging changes the lockfile, so the operator needs to run `npm install` in their
checkout. Crane leaves a task note reminding them. Until then, that checkout's
`tsc` stays on 5.9.3, and tests that use the import helper can't load it because
`@babel/parser` isn't installed. Package caches rebuild once after the install.

Don't use `npm ci --dry-run` to check a lockfile: on npm 9.2.0 it emptied
`node_modules` during this evaluation despite the flag. A real `npm ci` restored
the worktree.

Revisit the helper when 7.1's API is stable, if dropping the Babel dependencies
is worth it. Stay on the `~7.0.2` pin until then: 7.1 is still in beta.
