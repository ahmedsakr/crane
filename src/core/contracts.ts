/**
 * What the server and the web UI share: domain types, API response shapes,
 * labels, and small pure helpers. This is the only backend module `web/`
 * imports, and Vite bundles everything it reaches into the browser.
 *
 * Keep it browser-safe. The files it re-exports import nothing outside this
 * boundary: no `node:` modules, no packages, no Store, no filesystem or git
 * helpers. When the boundary gains a file, add it to `SHARED_SOURCES` in
 * `webbuild.ts` so a stale dashboard build is still noticed.
 * `test/contracts.test.ts` checks both.
 */

export * from "./types.js";
export { ruleLabel } from "./permissions.js";
