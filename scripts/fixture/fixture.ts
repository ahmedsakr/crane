/**
 * The screenshot fixture: what `npm run screenshot -- --fixture` pins so two
 * captures of one build can be compared pixel for pixel. `preload.ts` pins the
 * seed and server processes; the two page sources below pin the browser.
 *
 * Bump `version` when a change here or in seed-demo.ts moves pixels, so images
 * from before the change aren't compared with images from after it.
 */
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const FIXTURE = {
  version: 1,
  clock: "2026-01-15T16:00:00.000Z",
  timeZone: "UTC",
  locale: "en-US",
  randomSeed: "crane-screenshot-fixture",
  factory: "running with no factory process: one task held working, the rest held queued",
} as const;

/** Names the seed and server processes draw random values from, so a server can't reissue a seeded id. */
export type FixtureStream = "seed" | "serve";

const HOME_PREFIX = "crane-shot-fixture-";
const HOME_MARKER = ".crane-screenshot-fixture";

/** A new disposable home under the temp directory, marked so `preload.ts` accepts it. */
export function createFixtureHome(): string {
  const home = mkdtempSync(join(realpathSync(tmpdir()), HOME_PREFIX));
  writeFileSync(join(home, HOME_MARKER), "Disposable Crane home for a screenshot fixture.\n");
  return home;
}

/** Only a home `createFixtureHome` made qualifies, so the pinned clock and ids can never reach a real one. */
export function isFixtureHome(home: string): boolean {
  try {
    const real = realpathSync(home);
    return dirname(real) === realpathSync(tmpdir()) && basename(real).startsWith(HOME_PREFIX) && statSync(join(real, HOME_MARKER)).isFile();
  } catch {
    return false;
  }
}

/** The environment for a fixture process: git commits get fixed dates and ignore the operator's config. */
export function fixtureEnv(home: string, stream: FixtureStream): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CRANE_HOME: home,
    CRANE_SCREENSHOT_FIXTURE: stream,
    TZ: FIXTURE.timeZone,
    GIT_AUTHOR_DATE: FIXTURE.clock,
    GIT_COMMITTER_DATE: FIXTURE.clock,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Node arguments that run a script with the fixture's clock and random values. */
export const FIXTURE_NODE_ARGS = ["--import", "tsx", "--import", "./scripts/fixture/preload.ts"];

/** A small, repeatable generator (FNV-1a seed, mulberry32 steps). Returns values in [0, 1). */
export function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const ch of seed) state = Math.imul(state ^ ch.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Source that stops `Date` at one instant, shared by Node and the browser.
 * It's a string because tsx rewrites function bodies with helpers that don't
 * exist in the page. `performance.now` keeps running, so timers and frames work.
 */
export function fixedClockSource(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Not a timestamp: ${iso}`);
  return `(() => {
    const RealDate = globalThis.Date;
    globalThis.Date = new Proxy(RealDate, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [${ms}], newTarget),
      apply: () => new RealDate(${ms}).toString(),
      get: (target, key) => (key === "now" ? () => ${ms} : Reflect.get(target, key)),
    });
  })();`;
}

/** Source that turns off the motion reduced-motion leaves running, and the blinking caret. */
export const STILL_PAGE_SOURCE = `addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }";
  document.head.append(style);
});`;
