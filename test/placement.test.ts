import { test } from "node:test";
import assert from "node:assert/strict";
import { placeMenu } from "../web/src/lib/placement.ts";

const vp = { width: 1280, height: 800 };
const btn = (top: number, left: number, width = 200, height = 60) => ({ top, bottom: top + height, left, width });

test("menu opens below its button when it fits", () => {
  const p = placeMenu(btn(200, 100), { width: 260, height: 180 }, vp);
  assert.equal(p.top, 266);
  assert.equal(p.bottom, undefined);
  assert.equal(p.left, 100);
  assert.equal(p.minWidth, 200);
});

test("menu flips above when there is more room there", () => {
  const p = placeMenu(btn(640, 100), { width: 260, height: 180 }, vp);
  assert.equal(p.top, undefined);
  assert.equal(p.bottom, 800 - 640 + 6);
  assert.ok(p.maxHeight >= 180);
});

test("menu caps its height to the room it has and scrolls", () => {
  const p = placeMenu(btn(380, 100), { width: 260, height: 900 }, { width: 1280, height: 800 });
  assert.ok(p.maxHeight <= 340);
  const room = p.top !== undefined ? 800 - p.top - 12 : 800 - p.bottom! - 12;
  assert.ok(p.maxHeight <= room, `maxHeight ${p.maxHeight} exceeds room ${room}`);
});

test("menu slides left to stay inside the viewport", () => {
  const p = placeMenu(btn(200, 1100, 160), { width: 320, height: 150 }, vp);
  assert.equal(p.left, 1280 - 12 - 320);
});

test("menu never starts off the left edge on a narrow screen", () => {
  const p = placeMenu(btn(200, 4, 400), { width: 500, height: 150 }, { width: 360, height: 700 });
  assert.equal(p.left, 12);
  assert.equal(p.minWidth, 360 - 24);
});
