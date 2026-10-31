import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardBuilds, servedDashboard } from "../src/core/webbuild.ts";
import {
  buildDashboard,
  dashboardBuildNeeded,
  DashboardBuilder,
  pruneDashboardBuilds,
  type BuildWeb,
} from "../src/factory/dashboard.ts";
import { Store } from "../src/core/store.ts";
import { createApp } from "../src/server/app.ts";
import type { Repo } from "../src/core/types.ts";

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Stands in for `npm run build -w web`: "bundles" web/index.html, so the output shows which commit was built. */
const fakeBuild: BuildWeb = async (cwd, outDir) => {
  mkdirSync(join(outDir, "assets"), { recursive: true });
  const html = readFileSync(join(cwd, "web", "index.html"), "utf8");
  writeFileSync(join(outDir, "index.html"), html);
  writeFileSync(join(outDir, "assets", "app.js"), `console.log(${JSON.stringify(html)})`);
};

/** The operator's checkout of a Crane-like repo, with a web/index.html on main. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-dash-"));
  const checkout = join(root, "checkout");
  const builds = join(root, "builds");
  sh(root, "init", "-q", "-b", "main", checkout);
  const commit = (html: string) => {
    mkdirSync(join(checkout, "web"), { recursive: true });
    writeFileSync(join(checkout, "web", "index.html"), html);
    sh(checkout, "add", "-A");
    sh(checkout, "commit", "-q", "-m", html);
    return sh(checkout, "rev-parse", "HEAD");
  };
  const repo: Repo = { id: "r-crane", name: "crane", path: checkout, defaultBranch: "main", isFactory: true, addedAt: "" };
  return { root, checkout, builds, repo, commit, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A finished build, as `buildDashboard` leaves one, built `secondsAgo`. */
function fakeFinishedBuild(builds: string, sha: string, secondsAgo: number, html = sha) {
  mkdirSync(join(builds, sha, "dist"), { recursive: true });
  writeFileSync(join(builds, sha, "dist", "index.html"), html);
  writeFileSync(join(builds, sha, "build.json"), JSON.stringify({ sha, builtAt: Date.now() - secondsAgo * 1000 }));
}

/** The checkout's own web/dist, built `secondsAgo`. */
function checkoutBuild(root: string, secondsAgo: number) {
  mkdirSync(join(root, "web", "dist"), { recursive: true });
  const p = join(root, "web", "dist", "index.html");
  writeFileSync(p, "checkout");
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(p, t, t);
}

const A = "a".repeat(40);
const B = "b".repeat(40);

test("serves whichever dashboard was built last, Crane's or the checkout's", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-served-"));
  const root = join(dir, "checkout");
  const builds = join(dir, "builds");
  mkdirSync(builds, { recursive: true });
  assert.equal(servedDashboard(root, builds, 1), null, "nothing built at all");

  checkoutBuild(root, 100);
  fakeFinishedBuild(builds, A, 50);
  fakeFinishedBuild(builds, B, 10);
  // A build still in progress (no manifest yet) is never served.
  mkdirSync(join(builds, "c".repeat(40), "dist"), { recursive: true });
  writeFileSync(join(builds, "c".repeat(40), "dist", "index.html"), "half done");

  let served = servedDashboard(root, builds, 10_000)!;
  assert.equal(served.commit, B);
  assert.equal(served.dir, join(builds, B, "dist"));
  assert.deepEqual(served.fallbacks, [join(builds, A, "dist"), join(root, "web", "dist")]);
  assert.equal(served.outdated, false);

  // The operator runs npm run build: theirs is newest now.
  checkoutBuild(root, 1);
  served = servedDashboard(root, builds, 20_000)!;
  assert.equal(served.commit, null);
  assert.equal(served.dir, join(root, "web", "dist"));
  assert.match(served.id, /^checkout-/);
  rmSync(dir, { recursive: true, force: true });
});

test("builds a commit in Crane's own directory, never touching the checkout", async () => {
  const s = setup();
  const first = s.commit("<p>first</p>");
  const second = s.commit("<p>second</p>");
  // Local changes in the checkout must survive, and must not end up in the build.
  writeFileSync(join(s.checkout, "web", "index.html"), "<p>work in progress</p>");

  const dist = await buildDashboard(s.repo, first, { builds: s.builds, build: fakeBuild });
  assert.equal(dist, join(s.builds, first, "dist"));
  assert.equal(readFileSync(join(dist, "index.html"), "utf8"), "<p>first</p>");
  assert.deepEqual(dashboardBuilds(s.builds).map((b) => b.sha), [first]);

  assert.equal(readFileSync(join(s.checkout, "web", "index.html"), "utf8"), "<p>work in progress</p>");
  assert.equal(sh(s.checkout, "rev-parse", "HEAD"), second);
  assert.equal(sh(s.checkout, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.ok(!existsSync(join(s.checkout, "web", "dist")));
  // The scratch worktree is gone, from disk and from git.
  assert.equal(sh(s.checkout, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
  assert.deepEqual(readdirSync(join(s.builds, ".work")), []);

  // Building it again is a no-op.
  let calls = 0;
  await buildDashboard(s.repo, first, { builds: s.builds, build: async () => void calls++ });
  assert.equal(calls, 0);
  s.done();
});

test("a failed build leaves nothing behind and keeps serving the previous one", async () => {
  const s = setup();
  const good = s.commit("<p>good</p>");
  const bad = s.commit("<p>bad</p>");
  await buildDashboard(s.repo, good, { builds: s.builds, build: fakeBuild });

  const broken: BuildWeb = async (_cwd, outDir) => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "half.js"), "");
    throw new Error("src/App.tsx(3,1): error TS1005: ';' expected.");
  };
  await assert.rejects(buildDashboard(s.repo, bad, { builds: s.builds, build: broken }), /TS1005/);
  assert.ok(!existsSync(join(s.builds, bad)));
  assert.deepEqual(dashboardBuilds(s.builds).map((b) => b.sha), [good]);
  assert.equal(sh(s.checkout, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
  s.done();
});

test("only builds when the dashboard doesn't already contain the commit", async () => {
  const s = setup();
  const older = s.commit("<p>1</p>");
  const built = s.commit("<p>2</p>");
  const newer = s.commit("<p>3</p>");
  const opts = { builds: s.builds, root: join(s.root, "elsewhere") };
  assert.equal(await dashboardBuildNeeded(s.repo, built, opts), true);

  await buildDashboard(s.repo, built, { builds: s.builds, build: fakeBuild });
  assert.equal(await dashboardBuildNeeded(s.repo, built, opts), false, "already built");
  assert.equal(await dashboardBuildNeeded(s.repo, older, opts), false, "a later commit is built");
  assert.equal(await dashboardBuildNeeded(s.repo, newer, opts), true);

  // The operator built it themselves: the checkout's up-to-date web/dist contains it.
  checkoutBuild(s.checkout, 0);
  assert.equal(await dashboardBuildNeeded(s.repo, newer, { builds: s.builds, root: s.checkout }), false);
  s.done();
});

test("keeps only the newest few builds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-prune-"));
  const shas = ["1", "2", "3", "4", "5"].map((c) => c.repeat(40));
  shas.forEach((sha, i) => fakeFinishedBuild(dir, sha, 100 - i * 10));
  await pruneDashboardBuilds({ builds: dir, keep: 3 });
  assert.deepEqual(dashboardBuilds(dir).map((b) => b.sha), [shas[4], shas[3], shas[2]]);
  rmSync(dir, { recursive: true, force: true });
});

test("the builder builds only the newest of the merges that land while it's busy", async () => {
  const s = setup();
  const shas = [s.commit("<p>1</p>"), s.commit("<p>2</p>"), s.commit("<p>3</p>")];
  const built: string[] = [];
  const notes: [string, string][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const builder = new DashboardBuilder({
    repo: () => s.repo,
    log: () => {},
    note: (taskId, message) => notes.push([taskId, message]),
    builds: s.builds,
    root: join(s.root, "elsewhere"),
    build: async (cwd, out) => {
      await gate;
      built.push(readFileSync(join(cwd, "web", "index.html"), "utf8"));
      await fakeBuild(cwd, out);
    },
  });
  await builder.request(shas[0], "t-1");
  await builder.request(shas[1], "t-2");
  await builder.request(shas[2], "t-3");
  release();
  await builder.idle();

  assert.deepEqual(built, ["<p>1</p>", "<p>3</p>"]);
  assert.deepEqual(dashboardBuilds(s.builds)[0].sha, shas[2]);
  assert.deepEqual(notes.filter(([id]) => id === "t-3").map(([, m]) => m), [
    `Building the dashboard from ${shas[2].slice(0, 7)}`,
    `The dashboard now shows ${shas[2].slice(0, 7)}. Reload it to see the latest UI`,
  ]);
  assert.ok(!notes.some(([id]) => id === "t-2"), "superseded before it started");
  s.done();
});

test("the server serves Crane's build, its assets, and pages that aren't files", async () => {
  const home = mkdtempSync(join(tmpdir(), "crane-app-"));
  const prev = process.env.CRANE_HOME;
  process.env.CRANE_HOME = home;
  try {
    const builds = join(home, "builds");
    // Built "in the future", so it beats any web/dist in the checkout running the tests.
    fakeFinishedBuild(builds, A, -1_000_000, "<p>old build</p>");
    mkdirSync(join(builds, A, "dist", "assets"), { recursive: true });
    writeFileSync(join(builds, A, "dist", "assets", "old.js"), "old()");
    fakeFinishedBuild(builds, B, -2_000_000, "<p>crane build</p>");
    mkdirSync(join(builds, B, "dist", "assets"), { recursive: true });
    writeFileSync(join(builds, B, "dist", "assets", "app.js"), "app()");

    const store = new Store(join(home, "crane.db"));
    const app = createApp(store);
    const get = (path: string) => app.request(path);

    const page = await get("/tasks/t-123");
    assert.equal(await page.text(), "<p>crane build</p>");
    assert.equal(page.headers.get("cache-control"), "no-cache");

    const js = await get("/assets/app.js");
    assert.equal(await js.text(), "app()");
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.equal((await (await get("/assets/old.js")).text()), "old()", "an open page from the older build still loads");
    assert.equal((await get("/assets/missing.js")).status, 404);
    assert.equal(await (await get("/../build.json")).text(), "<p>crane build</p>");
    assert.equal(await (await get("/%2e%2e/build.json")).text(), "<p>crane build</p>");
    // Encoded slashes survive URL normalization and reach staticFile's decoder.
    // build.json exists just outside dist, so serving it would expose traversal.
    for (const path of ["/..%2fbuild.json", "/assets/..%2f..%2fbuild.json"]) {
      const response = await get(path);
      assert.equal(response.status, path.startsWith("/assets/") ? 404 : 200);
      assert.equal(await response.text(), path.startsWith("/assets/") ? "Not found" : "<p>crane build</p>");
    }

    const o = (await (await get("/api/overview")).json()) as { factory: { uiBuild: string; uiCommit: string; uiOutdated: boolean } };
    assert.equal(o.factory.uiBuild, B);
    assert.equal(o.factory.uiCommit, B);
    assert.equal(o.factory.uiOutdated, false);
    store.close();
  } finally {
    if (prev === undefined) delete process.env.CRANE_HOME;
    else process.env.CRANE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
