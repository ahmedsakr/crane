import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
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
  assert.ok(scripts.build.includes("npm run build:backend"));
  assert.ok(scripts.prepack.startsWith("npm run typecheck && "));
  assert.ok(scripts.typecheck.includes("tsc -p tsconfig.json --noEmit"));
  assert.ok(devDependencies.esbuild, "esbuild is a direct dependency, not borrowed from tsx");
});
