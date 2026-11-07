import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import Database from "better-sqlite3";
import { FIXTURE, FIXTURE_NODE_ARGS, createFixtureHome, fixedClockSource, fixtureEnv, isFixtureHome, seededRandom } from "../scripts/fixture/fixture.ts";
import { matrixCells, parseMatrix } from "../scripts/fixture/matrix.ts";
import { diffPngs, readPng, readPngMetadata, withPngMetadata } from "../scripts/fixture/png.ts";
import { incomparable } from "../scripts/screenshot-matrix.ts";
import { temporaryRoot } from "./support/fixtures.ts";

function fixtureHome(t: TestContext): string {
  const home = createFixtureHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function seed(home: string) {
  return spawnSync(process.execPath, [...FIXTURE_NODE_ARGS, "scripts/seed-demo.ts"], { env: fixtureEnv(home, "seed"), encoding: "utf8" });
}

/** Everything the seed stored, with the one thing that may differ (the temp home) taken out. */
function seededRows(home: string) {
  const db = new Database(join(home, "crane.db"), { readonly: true });
  try {
    const dump = Object.fromEntries(["tasks", "goals", "runs", "events", "repos", "agents"].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    return JSON.parse(JSON.stringify(dump).replaceAll(home, "<home>"));
  } finally {
    db.close();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

test("screenshot fixture: two seeds store identical ids, data and timestamps", { timeout: 120_000 }, (t) => {
  const [a, b] = [fixtureHome(t), fixtureHome(t)];
  for (const home of [a, b]) assert.equal(seed(home).status, 0);
  const rows = seededRows(a);
  assert.deepEqual(rows, seededRows(b));
  assert.ok(rows.tasks.length > 10);
  const latest = rows.tasks.map((task: { created_at: string }) => task.created_at).sort().at(-1);
  assert.equal(latest, FIXTURE.clock, "the newest task was created at the fixture's clock");

  const commits = [a, b].map((home) => {
    const log = spawnSync("git", ["log", "--all", "--format=%H"], { cwd: join(home, "demo-repos", "payments-api"), encoding: "utf8" });
    assert.equal(log.status, 0);
    return log.stdout;
  });
  assert.ok(commits[0]);
  assert.equal(commits[0], commits[1], "demo branches have the same commits in every home");
});

test("screenshot fixture: the seed refuses anything but a disposable fixture home", (t) => {
  const elsewhere = temporaryRoot(t, "crane-not-a-fixture-");
  const unmarked = join(realpathSync(tmpdir()), `crane-shot-fixture-unmarked-${process.pid}`);
  mkdirSync(unmarked);
  t.after(() => rmSync(unmarked, { recursive: true, force: true }));
  const marked = fixtureHome(t);
  assert.equal(isFixtureHome(marked), true);
  assert.equal(isFixtureHome(unmarked), false, "the name alone isn't enough");
  assert.equal(isFixtureHome(elsewhere), false);
  for (const home of [elsewhere, unmarked]) {
    const result = seed(home);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only runs in a disposable fixture home/);
  }
  const markerOutsideTemp = join(elsewhere, "crane-shot-fixture-copy");
  mkdirSync(markerOutsideTemp);
  writeFileSync(join(markerOutsideTemp, ".crane-screenshot-fixture"), "");
  assert.equal(isFixtureHome(markerOutsideTemp), false, "a marker outside the temp directory isn't enough");
});

test("screenshot fixture: the server holds one factory state, with stable paths", { timeout: 120_000 }, async (t) => {
  const home = fixtureHome(t);
  assert.equal(seed(home).status, 0);
  const port = await freePort();
  const server = spawn(process.execPath, [...FIXTURE_NODE_ARGS, "scripts/fixture/serve.ts", String(port)], { env: fixtureEnv(home, "serve"), stdio: "ignore" });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  t.after(async () => {
    server.kill("SIGTERM");
    await exited;
  });
  const get = (path: string) => fetch(`http://127.0.0.1:${port}/api/${path}`).then((r) => r.text());
  let first = "";
  for (let i = 0; i < 300 && !first; i++) {
    first = await get("tasks").catch(() => "");
    if (!first) await new Promise((r) => setTimeout(r, 100));
  }
  const overview = JSON.parse(await get("overview"));
  assert.equal(overview.factory.running, true);
  assert.equal(overview.factory.paused, false);
  const working = JSON.parse(first).filter((task: { status: string }) => task.status === "running");
  assert.equal(working.length, 1, "one task is held working");
  assert.ok(JSON.parse(first).some((task: { status: string }) => task.status === "queued"), "the rest stay queued");
  const repos: { path: string }[] = overview.repos;
  assert.ok(repos.every((r) => r.path.startsWith("/fixture/")), JSON.stringify(repos));

  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal(await get("tasks"), first, "nothing moved while the server ran");
  assert.equal(JSON.parse(await get("overview")).factory.running, true, "the heartbeat doesn't go stale");
});

test("screenshot fixture: the seeded generator repeats, and streams differ", () => {
  const draw = (seed: string) => {
    const random = seededRandom(seed);
    return [random(), random(), random()];
  };
  assert.deepEqual(draw("a"), draw("a"));
  assert.notDeepEqual(draw("a"), draw("b"));
  assert.ok(draw("a").every((n) => n >= 0 && n < 1));
});

test("screenshot fixture: the clock stops for every way of asking, and explicit dates still work", () => {
  const scope = { globalThis: { Date } as { Date: DateConstructor } };
  new Function("globalThis", fixedClockSource(FIXTURE.clock))(scope.globalThis);
  const Stopped = scope.globalThis.Date;
  assert.equal(Stopped.now(), Date.parse(FIXTURE.clock));
  assert.equal(new Stopped().toISOString(), FIXTURE.clock);
  assert.ok(new Stopped() instanceof Stopped);
  assert.equal(new Stopped("2020-01-02T00:00:00.000Z").toISOString(), "2020-01-02T00:00:00.000Z");
  assert.equal(Stopped.parse("2020-01-02T00:00:00.000Z"), Date.parse("2020-01-02T00:00:00.000Z"));
  assert.equal(Stopped(), new Date(FIXTURE.clock).toString());
});

/** A PNG with the given color type and one row filter, built by hand so filters get exercised. */
function png(width: number, rows: number[][], { color = 6, filter = 0 }: { color?: 2 | 6; filter?: number } = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header[8] = 8;
  header[9] = color;
  const raw = Buffer.concat(rows.map((row) => Buffer.from([filter, ...row])));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("screenshot fixture: PNGs decode through row filters and report the differing box", () => {
  const plain = readPng(png(2, [[1, 2, 3, 255, 4, 5, 6, 255], [7, 8, 9, 255, 10, 11, 12, 255]]));
  assert.deepEqual([...plain.rgba], [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
  // Filter 1 stores each byte as the difference from the pixel on its left.
  assert.deepEqual([...readPng(png(2, [[1, 2, 3, 255, 3, 3, 3, 0]], { filter: 1 })).rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
  // Filter 2 stores each byte as the difference from the row above.
  assert.deepEqual([...readPng(png(1, [[1, 2, 3, 255], [1, 1, 1, 0]], { filter: 2 })).rgba], [1, 2, 3, 255, 2, 3, 4, 255]);
  // RGB compares equal to the same image with opaque alpha.
  assert.equal(diffPngs(readPng(png(1, [[1, 2, 3]], { color: 2 })), readPng(png(1, [[1, 2, 3, 255]]))).differing, 0);

  const a = readPng(png(3, [[0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255], [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]]));
  const b = readPng(png(3, [[0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255], [0, 0, 0, 255, 9, 0, 0, 255, 9, 0, 0, 255]]));
  assert.deepEqual(diffPngs(a, a), { sameSize: true, differing: 0, box: null });
  assert.deepEqual(diffPngs(a, b), { sameSize: true, differing: 2, box: { x: 1, y: 1, width: 2, height: 1 } });
  assert.equal(diffPngs(a, readPng(png(1, [[0, 0, 0, 255]]))).sameSize, false);
});

test("screenshot fixture: metadata survives inside the PNG and leaves its pixels alone", () => {
  const image = png(1, [[1, 2, 3, 255]]);
  const meta = { fixture: FIXTURE, capture: { target: ".café-☃" } };
  const tagged = withPngMetadata(image, meta);
  assert.deepEqual(readPngMetadata(tagged), meta);
  assert.equal(readPngMetadata(image), null);
  assert.equal(diffPngs(readPng(tagged), readPng(image)).differing, 0);
  assert.deepEqual(tagged.subarray(0, 8), image.subarray(0, 8), "it's still a PNG to anything that checks the signature");
});

test("screenshot fixture: images compare only with the same fixture and framing", () => {
  const meta = { fixture: FIXTURE, capture: { target: ".a" }, build: "x" };
  assert.equal(incomparable(meta, { ...meta, build: "y" }), null, "builds are what's being compared");
  assert.match(incomparable(meta, { ...meta, capture: { target: ".b" } })!, /framed differently/);
  assert.match(incomparable(meta, { ...meta, fixture: { ...FIXTURE, version: 0 } })!, /different fixture/);
  assert.match(incomparable(meta, null)!, /no fixture metadata/);
});

test("screenshot fixture: a matrix fixes one framing across its sizes and media", () => {
  const valid = { name: "site", path: "/", target: ".site-canvas", ready: ".site-legend", scroll: { selector: "html", top: 40 }, sizes: ["1280x800", "390x844"], media: ["prefers-color-scheme=dark"] };
  const cells = matrixCells(parseMatrix(JSON.stringify(valid)));
  assert.deepEqual(cells.map((c) => c.file), ["site-1280x800-dark.png", "site-390x844-dark.png"]);
  assert.deepEqual(cells[1]!.args, ["/", "--fixture", "--target", ".site-canvas", "--wait-for", ".site-legend", "--scroll", "html=40", "--size", "390x844", "--media", "prefers-color-scheme=dark"]);
  assert.equal(matrixCells(parseMatrix(JSON.stringify({ ...valid, media: undefined })))[0]!.file, "site-1280x800.png");
  assert.deepEqual(matrixCells(parseMatrix(JSON.stringify({ ...valid, scroll: { center: ".site" } })))[0]!.args.slice(6, 8), ["--scroll-to", ".site"]);

  for (const broken of [
    { ...valid, target: undefined },
    { ...valid, target: [".a", ".b"] },
    { ...valid, ready: "" },
    { ...valid, scroll: undefined },
    { ...valid, scroll: { selector: "html" } },
    { ...valid, scroll: { center: ".a", selector: "html", top: 0 } },
    { ...valid, sizes: [] },
    { ...valid, sizes: ["wide"] },
    { ...valid, media: ["dark"] },
  ]) assert.throws(() => parseMatrix(JSON.stringify(broken)), JSON.stringify(broken));
});
