import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_STATUSES, type Task, type TaskStatus } from "@crane/contracts";
import {
  BOX,
  CAPACITY,
  CLEAR_Z,
  JIB_LEN,
  LAYERS,
  SiteModel,
  ZONE_IDS,
  ZONE_OF,
  ZONES,
  bearing,
  fit,
  inPolygon,
  orbit,
  project,
  slotPos,
} from "../web/src/lib/site.ts";

const task = (id: string, status: TaskStatus) => ({ id, status, title: id }) as unknown as Task;

/** The crate the crane is working on, read fresh (asserts on `m.job` narrow it). */
const jobOf = (m: SiteModel) => m.job?.id;

/** Step the model until nothing moves (or give up after a simulated minute). */
function settle(m: SiteModel, limit = 60) {
  let t = 0;
  while (m.busy && t < limit) {
    m.step(1 / 60);
    t += 1 / 60;
  }
  return t;
}

test("every status has an area, and the areas run in order of progress", () => {
  for (const s of ALL_STATUSES) assert.ok(ZONE_IDS.includes(ZONE_OF[s]), s);
  assert.equal(ZONE_OF.running, "working");
  assert.equal(ZONE_OF.merging, "merging");
  assert.equal(ZONE_OF.merged, "shipped");
  assert.equal(ZONE_OF.failed, "stopped");
  const xs = ZONE_IDS.map((z) => ZONES[z].x);
  assert.deepEqual(
    xs,
    [...xs].sort((a, b) => a - b),
  );
});

test("every slot is in front of the mast and within the jib's reach", () => {
  for (const z of ZONE_IDS)
    for (let i = 0; i < CAPACITY; i++) {
      const s = slotPos(z, i);
      assert.ok(Math.hypot(s.x, s.y) < JIB_LEN - 0.3, `${z}[${i}] out of reach`);
      const a = bearing(s.x, s.y);
      assert.ok(a > -Math.PI && a < 0, `${z}[${i}] behind the mast`);
    }
  // The hook's carrying height clears a full stack with a crate hanging below it.
  assert.ok(CLEAR_Z - BOX.h > LAYERS * BOX.h);
});

test("tasks on site when the page opens are placed without moving the crane", () => {
  const m = new SiteModel();
  m.sync([task("a", "running"), task("b", "merged"), task("c", "needs_review")]);
  assert.equal(m.job, null);
  assert.equal(m.payloads.get("a")!.zone, "working");
  assert.equal(m.payloads.get("b")!.zone, "shipped");
  assert.equal(m.count("review"), 1);
  assert.deepEqual(m.stacks.working, ["a"]);
});

test("a status change sends the crane to carry the crate to its new area", () => {
  const m = new SiteModel();
  m.sync([task("a", "running")]);
  settle(m);
  m.sync([task("a", "merging")]);
  m.step(1 / 60);
  assert.equal(m.job?.id, "a");
  assert.equal(m.job?.to, "merging");

  let lifted = false;
  let t = 0;
  while (m.busy && t < 60) {
    m.step(1 / 60);
    t += 1 / 60;
    const p = m.payloads.get("a")!;
    if (p.carried) {
      lifted = true;
      // A carried crate hangs from the hook.
      const h = m.hookLoad();
      assert.ok(Math.abs(p.pos.x - h.x) < 1e-9 && Math.abs(p.pos.z - h.z) < 1e-9);
    }
  }
  assert.ok(lifted, "the crate was never lifted");
  assert.ok(t < 20, `took ${t.toFixed(1)}s`);
  const p = m.payloads.get("a")!;
  assert.equal(p.zone, "merging");
  assert.deepEqual(m.stacks.working, []);
  assert.deepEqual(m.stacks.merging, ["a"]);
  const s = slotPos("merging", 0);
  assert.ok(Math.abs(p.pos.x - s.x) < 0.01 && Math.abs(p.pos.y - s.y) < 0.01 && Math.abs(p.pos.z - s.z) < 0.01);
});

test("moves queue up and run one at a time, each to its latest status", () => {
  const m = new SiteModel();
  m.sync([task("a", "running"), task("b", "running")]);
  m.sync([task("a", "needs_review"), task("b", "failed")]);
  m.step(1 / 60);
  assert.equal(m.job?.id, "a");
  // b changes again before the crane gets to it.
  m.sync([task("a", "needs_review"), task("b", "merged")]);
  settle(m);
  assert.equal(m.payloads.get("a")!.zone, "review");
  assert.equal(m.payloads.get("b")!.zone, "shipped");
  assert.deepEqual(m.stacks.stopped, []);
});

test("new tasks arrive in the queue area and are carried on from there", () => {
  const m = new SiteModel();
  m.sync([]);
  m.sync([task("n", "running")]);
  assert.equal(m.payloads.get("n")!.zone, "queued");
  settle(m);
  assert.equal(m.payloads.get("n")!.zone, "working");
});

test("tasks that drop off the overview leave the site, even mid-lift", () => {
  const m = new SiteModel();
  m.sync([task("a", "merged"), task("b", "running")]);
  m.sync([task("b", "running")]);
  settle(m);
  assert.equal(m.payloads.has("a"), false);
  assert.deepEqual(m.stacks.shipped, []);

  m.sync([task("b", "failed")]);
  m.step(0.2); // the crane is on its way
  m.sync([]);
  settle(m);
  assert.equal(m.payloads.size, 0);
  assert.equal(m.job, null);
  for (const z of ZONE_IDS) assert.deepEqual(m.stacks[z], [], z);

  // One already on the hook is set down first, then leaves.
  m.sync([task("c", "running")]);
  settle(m);
  m.sync([task("c", "failed")]);
  for (let t = 0; t < 20 && !m.payloads.get("c")!.carried; t += 1 / 60) m.step(1 / 60);
  assert.equal(m.payloads.get("c")!.carried, true);
  m.sync([]);
  assert.equal(jobOf(m), "c");
  settle(m);
  assert.equal(m.payloads.size, 0);
  for (const z of ZONE_IDS) assert.deepEqual(m.stacks[z], [], z);
});

test("the crane lifts from the top of a stack and the stack stays packed", () => {
  const m = new SiteModel();
  const ids = Array.from({ length: 6 }, (_, i) => `q${i}`);
  m.sync(ids.map((id) => task(id, "queued")));
  // The bottom crate in the first column is picked; the one above it moves out of the way.
  m.sync(ids.map((id) => task(id, id === "q0" ? "running" : "queued")));
  m.step(1 / 60);
  assert.equal(m.stacks.queued[4], "q0");
  settle(m);
  assert.equal(m.stacks.queued.length, 5);
  assert.ok(!m.stacks.queued.includes("q0"));
  // Every remaining crate rests in the slot its index says.
  m.stacks.queued.forEach((id, i) => {
    const p = m.payloads.get(id)!;
    assert.ok(Math.abs(p.pos.z - slotPos("queued", i).z) < 0.01, id);
  });
});

test("with reduced motion every move lands at once", () => {
  const m = new SiteModel({ instant: true });
  m.sync([task("a", "running")]);
  m.sync([task("a", "merged"), task("b", "queued")]);
  assert.equal(m.job, null);
  assert.equal(m.payloads.get("a")!.zone, "shipped");
  assert.equal(m.payloads.get("b")!.grow, 1);
});

test("the camera projects nearer things larger and fits the scene to the canvas", () => {
  const cam = fit(orbit({ x: 0, y: 0, z: 0 }, -Math.PI / 2, 0.4, 30), [{ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }], 400, 200, 10);
  const l = project(cam, { x: -5, y: 0, z: 0 });
  const r = project(cam, { x: 5, y: 0, z: 0 });
  const top = project(cam, { x: 0, y: 0, z: 4 });
  for (const p of [l, r, top]) assert.ok(p.x >= 9.9 && p.x <= 390.1 && p.y >= 9.9 && p.y <= 190.1, JSON.stringify(p));
  assert.ok(top.y < l.y, "up is up on screen");
  const near = project(cam, { x: 1, y: -10, z: 0 }).x - project(cam, { x: 0, y: -10, z: 0 }).x;
  const far = project(cam, { x: 1, y: 10, z: 0 }).x - project(cam, { x: 0, y: 10, z: 0 }).x;
  assert.ok(near > far);
});

test("hit testing finds points inside a polygon", () => {
  const sq = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(inPolygon(5, 5, sq), true);
  assert.equal(inPolygon(15, 5, sq), false);
});
