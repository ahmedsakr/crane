import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { specifiers } from "./support/imports.ts";

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

  // Setup must diagnose missing tools even when persistent-home initialization would fail.
  const setup = spawnSync(process.execPath, [join(out, "cli", "index.js"), "setup", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env, PATH: out, CRANE_HOME: join(out, "cli", "index.js"),
      CRANE_CLAUDE_BIN: join(out, "missing-claude"), CRANE_CODEX_BIN: join(out, "missing-codex"),
    },
  });
  assert.equal(setup.status, 1, setup.stderr);
  const setupReport = JSON.parse(setup.stdout);
  assert.equal(setupReport.ready, false);
  for (const id of ["git", "npm", "agent"]) {
    assert.equal(setupReport.checks.find((check: { id: string }) => check.id === id)?.status, "fail");
  }
  assert.equal(setupReport.checks.find((check: { id: string }) => check.id === "sqlite")?.status, "pass");

  // Application identity follows application output, independently of compiled workspace locations.
  const { factoryRoot } = await import(pathToFileURL(join(out, "application.js")).href);
  assert.equal(factoryRoot(), dirname(out));

  // An installed application's identity and assets belong to crane, not its bundled runtime.
  const installed = mkdtempSync(join(cache, "crane-installed-test-"));
  t.after(() => rmSync(installed, { recursive: true, force: true }));
  const app = join(installed, "node_modules", "crane");
  mkdirSync(app, { recursive: true });
  cpSync(out, join(app, "dist"), { recursive: true });
  cpSync(join(root, "bin"), join(app, "bin"), { recursive: true });
  cpSync(join(root, "package.json"), join(app, "package.json"));
  const runtime = join(app, "node_modules", "@crane", "backend-runtime");
  mkdirSync(runtime, { recursive: true });
  cpSync(join(root, "packages", "backend-runtime", "dist"), join(runtime, "dist"), { recursive: true });
  cpSync(join(root, "packages", "backend-runtime", "package.json"), join(runtime, "package.json"));
  mkdirSync(join(app, "web", "dist"), { recursive: true });
  writeFileSync(join(app, "web", "dist", "index.html"), "installed dashboard");
  const identity = await import(pathToFileURL(join(app, "dist", "application.js")).href);
  assert.equal(identity.factoryRoot(), app);
  const previousHome = process.env.CRANE_HOME;
  process.env.CRANE_HOME = join(installed, "home");
  try {
    assert.equal(identity.servedDashboard()?.dir, join(app, "web", "dist"));
  } finally {
    if (previousHome === undefined) delete process.env.CRANE_HOME;
    else process.env.CRANE_HOME = previousHome;
  }
  assert.equal(identity.factoryBuildOutdated(), false, "installed package has no source inputs");
  const installedHelp = spawnSync(process.execPath, [join(app, "bin", "crane.js"), "--help"], {
    encoding: "utf8", env: { ...process.env, CRANE_HOME: join(installed, "home") },
  });
  assert.equal(installedHelp.status, 0, installedHelp.stderr);
  assert.match(installedHelp.stdout, /Usage: crane/);

  // Serve is loaded on demand, so `--help` above doesn't load it.
  const { serve } = await import(pathToFileURL(join(out, "cli", "serve.js")).href);
  assert.equal(typeof serve, "function");

  const map = JSON.parse(readFileSync(join(out, "application.js.map"), "utf8"));
  assert.ok(map.sources.some((source: string) => source.endsWith("src/application.ts")), map.sources.join());
  assert.ok(!existsSync(join(out, "src")), "--outbase keeps src/ out of the output path");

  // Rebuilds rewrite the application marker even when content is unchanged; running checks retain their captured marker.
  const marker = join(out, "cli", "index.js");
  const old = new Date(1_000_000_000_000);
  utimesSync(marker, old, old);
  emit(out);
  assert.ok(statSync(marker).mtimeMs > old.getTime(), "a rebuild rewrites unchanged output");
});

test("build: tsc is TypeScript 7 and nothing else in the tree can take over its bin", () => {
  const { packages } = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const providers = Object.entries<{ bin?: Record<string, string> }>(packages)
    .filter(([, entry]) => entry.bin?.tsc)
    .map(([path]) => path);
  // @typescript/typescript6 is one way to break this: its dependency installs an old `tsc` that wins the link.
  assert.deepEqual(providers, ["node_modules/typescript"]);
  assert.match(packages["node_modules/typescript"].version, /^7\./);
  assert.equal(packages[""].devDependencies.typescript, packages.web.devDependencies.typescript, "web uses the same compiler");
});

test("build: type errors are caught before packing, since build doesn't check types", () => {
  const { scripts, devDependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(!/\btsc\b/.test(scripts["build:backend"]));
  assert.ok(scripts.prepack.startsWith("npm run typecheck && "));
  // npm run typecheck runs every project's typecheck target, the backend's included (test/nx-graph.test.ts).
  const backend = JSON.parse(readFileSync(join(root, "src", "project.json"), "utf8"));
  assert.ok(scripts.typecheck.includes("scripts/tasks.ts typecheck"));
  assert.ok(backend.targets.typecheck.options.command.endsWith("tsc -p tsconfig.json --noEmit"));
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

/** Nx itself, its plugins, or the scripts that drive it. */
const NX_MODULE = /^(nx|@nx\/[\w-]+)(\/|$)|(^|\/)scripts\//;

test("build: build, dev, source CLI and dashboard workflows never start Nx, so its config is no factory build input", () => {
  // webbuild.ts stales the factory and dashboard on src/ and package sources only. That is complete
  // while nothing here runs Nx: Nx's config would otherwise decide what the factory runs.
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const web = JSON.parse(readFileSync(join(root, "web", "package.json"), "utf8"));
  const workflows = ["build", "build:packages", "build:backend", "predev", "dev", "dev:packages", "predev:server", "dev:server", "dev:web", "precrane", "crane"];
  for (const name of workflows) {
    assert.ok(scripts[name], name);
    assert.doesNotMatch(scripts[name], /\bnx\b|scripts\/tasks\.ts/, name);
  }
  for (const [name, command] of Object.entries<string>(web.scripts)) assert.doesNotMatch(command, /\bnx\b/, `web ${name}`);
  assert.doesNotMatch(readFileSync(join(root, "scripts", "build.mjs"), "utf8"), /\bnx\b/i);
  assert.deepEqual(specifiers(join(root, "scripts", "build.mjs")).filter((spec) => NX_MODULE.test(spec)), []);
});

test("build: the packaged CLI ships and imports nothing of Nx, which stays a development dependency", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.files, ["bin/", "dist/", "web/dist/"], "no nx.json or project.json in the tarball");
  assert.ok(manifest.devDependencies.nx);
  assert.equal(manifest.dependencies.nx, undefined);
  assert.ok(!manifest.bundledDependencies.some((name: string) => NX_MODULE.test(name)));
  const workspaces = manifest.workspaces.map((dir: string) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")));
  for (const ws of workspaces) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      assert.deepEqual(Object.keys(ws[field] ?? {}).filter((name) => NX_MODULE.test(name)), [], `${ws.name} ${field}`);
    }
  }
  // The compiled CLI is these sources, one file each (build:backend doesn't bundle).
  const dirs = ["src", ...readdirSync(join(root, "packages")).map((dir) => join("packages", dir, "src"))];
  const sources = dirs.filter((dir) => existsSync(join(root, dir))).flatMap((dir) =>
    (readdirSync(join(root, dir), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => join(root, dir, f)));
  sources.push(join(root, "bin", "crane.js"));
  const found = sources.flatMap((file) => specifiers(file).filter((spec) => NX_MODULE.test(spec)).map((spec) => `${file}: ${spec}`));
  assert.deepEqual(found, []);
});

test("build: web's prebuild compiles only contracts, without npm, since the root build skips it", () => {
  const { scripts } = JSON.parse(readFileSync(join(root, "web", "package.json"), "utf8"));
  assert.equal(scripts.prebuild, "tsc -b ../packages/contracts/tsconfig.json");
  assert.equal(scripts.build, "vite build");
});
