/**
 * `node --import` preload for the fixture's seed and server processes. It stops
 * the clock and makes Math.random and randomBytes repeatable before any Crane
 * code loads, so scripts/seed-demo.ts and the store need no fixture mode of their
 * own. It refuses to run against anything but a disposable fixture home.
 */
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { runInThisContext } from "node:vm";
import { FIXTURE, fixedClockSource, isFixtureHome, seededRandom } from "./fixture.ts";

const stream = process.env.CRANE_SCREENSHOT_FIXTURE;
const home = process.env.CRANE_HOME;
if (!stream || !home || !isFixtureHome(home)) {
  console.error(`The screenshot fixture only runs in a disposable fixture home, not ${home ?? "the default Crane home"}.`);
  process.exit(1);
}

runInThisContext(fixedClockSource(FIXTURE.clock));

const random = seededRandom(`${FIXTURE.randomSeed}:${stream}`);
Math.random = random;
crypto.randomBytes = ((size: number) => Buffer.from(Array.from({ length: size }, () => Math.floor(random() * 256)))) as typeof crypto.randomBytes;
syncBuiltinESMExports();
