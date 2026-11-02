import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs the real build:backend script, sent somewhere disposable. Node still finds dependencies by walking up. */
function emit(outdir: string) {
  const run = spawnSync("npm", ["run", "--silent", "build:backend", "--", `--outdir=${outdir}`], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

test("build: esbuild's backend output runs from the layout the factory expects", async t => {
  const cache = join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const out = mkdtempSync(join(cache, "crane-build-test-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  emit(out);

  // bin/crane.js loads this exact path, and it starts the CLI.
  const help = spawnSync(process.execPath, [join(out, "cli", "index.js"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, CRANE_HOME: join(out, "home") },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: crane/);

  // factoryRoot() counts directories up from the compiled file, which a bundle would break.
  const { factoryRoot } = await import(pathToFileURL(join(out, "core", "paths.js")).href);
  assert.equal(factoryRoot(), dirname(out));

  // The CLI's one dynamic import, so `--help` above doesn't load it.
  const { serve } = await import(pathToFileURL(join(out, "cli", "serve.js")).href);
  assert.equal(typeof serve, "function");

  const map = JSON.parse(readFileSync(join(out, "core", "paths.js.map"), "utf8"));
  assert.ok(map.sources.some((source: string) => source.endsWith("src/core/paths.ts")), map.sources.join());
  assert.ok(!existsSync(join(out, "src")), "--outbase keeps src/ out of the output path");

  // The outdated notice clears only if a rebuild moves this file's mtime, even when its content is unchanged.
  const marker = join(out, "cli", "index.js");
  const old = new Date(1_000_000_000_000);
  utimesSync(marker, old, old);
  emit(out);
  assert.ok(statSync(marker).mtimeMs > old.getTime(), "a rebuild rewrites unchanged output");
});

test("build: type errors are caught before packing, since build doesn't check types", () => {
  const { scripts, devDependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(!/\btsc\b/.test(scripts["build:backend"]));
  assert.ok(scripts.prepack.startsWith("npm run typecheck && "));
  assert.ok(scripts.typecheck.includes("tsc -p tsconfig.json --noEmit"));
  assert.ok(devDependencies.esbuild, "esbuild is a direct dependency, not borrowed from tsx");
});

/**
 * A disposable checkout running the real build script and link check, where
 * each step logs its name. `npm` logs too and fails, so a nested start shows.
 */
function buildFixture(t: { after(fn: () => void): void }, backend = 'echo backend >> "$BUILD_LOG"') {
  const dir = mkdtempSync(join(tmpdir(), "crane-build-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "build.log");
  const executable = (path: string, body: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  mkdirSync(join(dir, "scripts"));
  for (const script of ["build.mjs", "check-workspace-links.mjs"]) cpSync(join(root, "scripts", script), join(dir, "scripts", script));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    workspaces: ["web"],
    scripts: {
      "build:packages": 'node scripts/check-workspace-links.mjs && echo packages >> "$BUILD_LOG"',
      "build:backend": backend,
    },
  }));
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "package.json"), JSON.stringify({
    name: "@fixture/web",
    scripts: { prebuild: 'echo prebuild >> "$BUILD_LOG"', build: "vite build --flag" },
  }));
  executable("web/node_modules/.bin/vite", 'echo "vite $* in $(basename "$PWD")" >> "$BUILD_LOG"');
  executable("node_modules/.bin/npm", 'echo npm >> "$BUILD_LOG"\nexit 1');
  mkdirSync(join(dir, "node_modules", "@fixture"));
  symlinkSync(join(dir, "web"), join(dir, "node_modules", "@fixture", "web"));
  return {
    dir,
    build: () => spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: dir, encoding: "utf8", env: { ...process.env, BUILD_LOG: log } }),
    steps: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

test("build: runs each step in order, finding Vite under web/, and starts no npm", t => {
  const { build, steps } = buildFixture(t);
  const run = build();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(steps(), ["packages", "backend", "vite build --flag in web"], "web's prebuild is skipped too");
});

test("build: a stale install stops at the link check, before anything compiles", t => {
  const { dir, build, steps } = buildFixture(t);
  rmSync(join(dir, "node_modules", "@fixture", "web"));
  const run = build();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /@fixture\/web/);
  assert.match(run.stderr, /run npm install/);
  assert.deepEqual(steps(), []);
});

test("build: a failed step stops the build and keeps its exit status", t => {
  const { build, steps } = buildFixture(t, "exit 3");
  assert.equal(build().status, 3);
  assert.deepEqual(steps(), ["packages"]);
});

test("build: web's prebuild compiles only contracts, without npm, since the root build skips it", () => {
  const { scripts } = JSON.parse(readFileSync(join(root, "web", "package.json"), "utf8"));
  assert.equal(scripts.prebuild, "tsc -b ../packages/contracts/tsconfig.json");
  assert.equal(scripts.build, "vite build");
});
