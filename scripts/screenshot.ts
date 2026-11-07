/**
 * Take screenshots of the web UI in headless Chromium, to debug visual bugs.
 * Boots a throwaway demo factory (seeded, simulated agents) unless --url points
 * at one that's already running. Drives Chromium over its DevTools pipe, so it
 * needs no browser library, just a Chromium binary.
 *
 *   npm run build -w web &&
 *   npm run screenshot -- "/?instruct=Fix the flaky tests" --click ".choice-btn" --out /tmp/menu.png
 *
 * Options (steps run in the order given, one screenshot at the end):
 *   [path]            page to open, default "/"
 *   --url <origin>    use a running factory instead of booting a demo one
 *   --fixture         boot the repeatable fixture instead of the live demo: fixed
 *                     ids, data, clock, time zone and locale, no motion, and a
 *                     held factory state (scripts/fixture/). Waits for the page
 *                     to stop changing and stores what it pinned in each PNG.
 *                     For comparing images, see npm run screenshot:matrix.
 *   --target <sel>    crop screenshots to the part of this element in the viewport
 *   --size <WxH>      viewport, default 1280x800
 *   --media <f>=<v>   emulate a media feature for the whole run, like
 *                     prefers-color-scheme=dark or prefers-reduced-motion=reduce (repeatable)
 *   --wait-for <sel>  wait until a selector exists
 *   --click <sel>     click the first match with a real mouse event
 *   --type <text>     type into the focused element
 *   --key <key>       press a key, like Escape or Enter
 *   --scroll <sel>=<px>  set scrollTop on the first match
 *   --scroll-to <sel>    scroll until the first match is centered in view
 *   --sleep <ms>      wait
 *   --eval <js>       run an expression and print its JSON result
 *   --shot <file>     take a screenshot now (repeatable)
 *   --out <file>      final screenshot, default .crane/screenshot.png
 *
 * Finds Chromium on PATH, in Playwright's cache, or at $CRANE_CHROMIUM.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { webBuildOutdated } from "../src/core/webbuild.js";
import { FIXTURE, FIXTURE_NODE_ARGS, STILL_PAGE_SOURCE, createFixtureHome, fixedClockSource, fixtureEnv } from "./fixture/fixture.ts";
import { withPngMetadata } from "./fixture/png.ts";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

type Step = { op: string; arg: string };
const args = process.argv.slice(2);
let path = "/";
let origin: string | null = null;
let fixture = false;
let target: string | null = null;
let size = "1280x800";
let out = join(root, ".crane", "screenshot.png");
const steps: Step[] = [];
const media: { name: string; value: string }[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  const next = () => {
    const v = args[++i];
    if (v === undefined) fail(`${a} needs a value`);
    return v;
  };
  if (a === "--url") origin = next().replace(/\/$/, "");
  else if (a === "--fixture") fixture = true;
  else if (a === "--target") target = next();
  else if (a === "--size") size = next();
  else if (a === "--media") {
    const [name, value] = next().split("=");
    if (!name || !value) fail(`--media should look like prefers-color-scheme=dark`);
    media.push({ name, value });
  }
  else if (a === "--out") out = resolve(next());
  else if (["--wait-for", "--click", "--type", "--key", "--scroll", "--scroll-to", "--sleep", "--eval", "--shot"].includes(a))
    steps.push({ op: a.slice(2), arg: next() });
  else if (a.startsWith("--")) fail(`Unknown option ${a}`);
  else path = a.startsWith("/") ? a : `/${a}`;
}
const [width, height] = size.split("x").map(Number) as [number, number];
if (!width || !height) fail(`--size should look like 1280x800, got ${size}`);
if (fixture && origin) fail("--fixture boots its own factory, so it can't be used with --url.");
// The site's work lights and camera only hold still for reduced motion.
if (fixture && !media.some((m) => m.name === "prefers-reduced-motion")) media.push({ name: "prefers-reduced-motion", value: "reduce" });

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function findChromium(): string {
  const env = process.env.CRANE_CHROMIUM;
  if (env) return env;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      return execFileSync("which", [name], { encoding: "utf8" }).trim();
    } catch {}
  }
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      for (const bin of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = join(cache, dir, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  fail("No Chromium found. Install one, run `npx playwright install chromium`, or set CRANE_CHROMIUM.");
}

function freePort(): Promise<number> {
  return new Promise((ok, no) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
    s.on("error", no);
  });
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const children: ChildProcess[] = [];
const cleanup: (() => void)[] = [];
const done = () => {
  for (const c of children) c.kill("SIGTERM");
  for (const f of cleanup) {
    try {
      f();
    } catch {
      // A temp dir left behind is harmless.
    }
  }
};
process.on("exit", done);

async function bootDemo(): Promise<string> {
  if (!existsSync(join(root, "web", "dist", "index.html"))) fail("Build the UI first: npm run build -w web");
  const home = mkdtempSync(join(tmpdir(), "crane-shot-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, CRANE_HOME: home };
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-demo.ts"], { cwd: root, env, stdio: "ignore" });
  const port = await freePort();
  // --no-build-dashboard: screenshot this checkout's web/dist, never a build of its default branch.
  const args = ["serve", "--port", String(port), "--driver", "simulated", "--no-build-dashboard"];
  const server = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: root,
    env,
    stdio: "ignore",
  });
  children.push(server);
  // The factory listens on 127.0.0.1; "localhost" can resolve to ::1 first.
  const url = `http://127.0.0.1:${port}`;
  await waitFor("the demo factory", () => fetch(`${url}/api/overview`).then((r) => r.ok));
  return url;
}

/** Like bootDemo, with the seed and server pinned and no factory process. */
async function bootFixture(): Promise<string> {
  if (!existsSync(join(root, "web", "dist", "index.html"))) fail("Build the UI first: npm run build -w web");
  // An outdated build shows a notice in the page, and would compare the wrong UI anyway.
  if (webBuildOutdated(root)) fail("web/dist is older than its source. Rebuild it first: npm run build -w web");
  const home = createFixtureHome();
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  execFileSync(process.execPath, [...FIXTURE_NODE_ARGS, "scripts/seed-demo.ts"], { cwd: root, env: fixtureEnv(home, "seed"), stdio: ["ignore", "ignore", "inherit"] });
  const port = await freePort();
  const server = spawn(process.execPath, [...FIXTURE_NODE_ARGS, "scripts/fixture/serve.ts", String(port)], {
    cwd: root,
    env: fixtureEnv(home, "serve"),
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(server);
  server.on("exit", (code) => fail(`The fixture server exited (${code}) before the screenshot.`));
  const url = `http://127.0.0.1:${port}`;
  await waitFor("the fixture server", () => fetch(`${url}/api/overview`).then((r) => r.ok));
  return url;
}

/** Chrome DevTools Protocol over --remote-debugging-pipe: NUL-delimited JSON on fds 3 (in) and 4 (out). */
class Cdp {
  private id = 0;
  private pending = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private listeners: ((m: any) => void)[] = [];
  private buf = "";
  constructor(
    private input: Writable,
    output: Readable,
  ) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        const p = msg.id !== undefined && this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.no(new Error(`${msg.error.message} (${msg.error.code})`));
          else p.ok(msg.result);
        } else for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    return new Promise((ok, no) => this.pending.set(id, { ok, no }));
  }
  once(method: string): Promise<any> {
    return new Promise((ok) => {
      const l = (m: any) => {
        if (m.method !== method) return;
        this.listeners = this.listeners.filter((x) => x !== l);
        ok(m.params);
      };
      this.listeners.push(l);
    });
  }
}

function launchBrowser() {
  const profile = mkdtempSync(join(tmpdir(), "crane-chromium-"));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  const chrome = spawn(
    findChromium(),
    [
      "--headless=new",
      "--remote-debugging-pipe",
      // Ubuntu 23.10+ blocks the user-namespace sandbox via AppArmor. Like
      // Playwright's default, skip it: this only ever loads Crane's own UI.
      "--no-sandbox",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  children.push(chrome);
  let stderr = "";
  chrome.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const crashed = (code: number | null) => fail(`Chromium exited (${code}) before the screenshot.\n${stderr.trim()}`);
  chrome.on("exit", crashed);
  for (const s of [chrome.stdio[3], chrome.stdio[4]]) s?.on("error", () => {});
  const cdp = new Cdp(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);
  return { chrome, cdp, crashed };
}

type PageCommand = (method: string, params?: object) => Promise<any>;
type Evaluate = (expression: string) => Promise<any>;

async function configurePage(cdp: Cdp): Promise<PageCommand> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method: string, params: object = {}) => cdp.send(method, params, sessionId);
  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  if (media.length) await page("Emulation.setEmulatedMedia", { features: media });
  if (fixture) await pinBrowser(page);
  return page;
}

/** The browser's half of the fixture: its clock, time zone, locale and motion. */
async function pinBrowser(page: PageCommand) {
  await page("Emulation.setTimezoneOverride", { timezoneId: FIXTURE.timeZone });
  await page("Emulation.setLocaleOverride", { locale: FIXTURE.locale });
  for (const source of [fixedClockSource(FIXTURE.clock), STILL_PAGE_SOURCE]) await page("Page.addScriptToEvaluateOnNewDocument", { source });
}

type Clip = { x: number; y: number; width: number; height: number; scale: 1 };

/** The part of the target inside the viewport, on whole pixels so it's never resampled. */
async function targetClip(evaluate: Evaluate): Promise<Clip | undefined> {
  if (!target) return undefined;
  const clip = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(target)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const [left, top] = [Math.max(0, Math.floor(r.left)), Math.max(0, Math.floor(r.top))];
    const [right, bottom] = [Math.min(innerWidth, Math.ceil(r.right)), Math.min(innerHeight, Math.ceil(r.bottom))];
    return { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top, scale: 1 };
  })()`);
  if (!clip) throw new Error(`No element matches --target ${target}`);
  if (clip.width <= 0 || clip.height <= 0) throw new Error(`--target ${target} is out of view. Set a scroll position that shows it.`);
  return clip;
}

/** How long the page must look the same, and how long it gets to get there. */
const STILL_FRAMES = 3;
const STILL_INTERVAL_MS = 250;
const STILL_TIMEOUT_MS = 10_000;

/** A capture taken once consecutive frames match. Data arriving late or motion left running would otherwise split repeats. */
async function stillFrame(capture: () => Promise<string>): Promise<string> {
  const until = Date.now() + STILL_TIMEOUT_MS;
  let frame = await capture();
  let same = 1;
  while (same < STILL_FRAMES) {
    if (Date.now() > until) throw new Error(`The page kept changing for ${STILL_TIMEOUT_MS / 1000} s, so a capture wouldn't be repeatable.`);
    await new Promise((r) => setTimeout(r, STILL_INTERVAL_MS));
    const next = await capture();
    same = next === frame ? same + 1 : 1;
    frame = next;
  }
  return frame;
}

function pageTools(page: PageCommand, metadata: object | null) {
  const evaluate: Evaluate = async (expression) => {
    const r = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const shoot = async (file: string) => {
    const capture = async () => {
      const clip = await targetClip(evaluate);
      return (await page("Page.captureScreenshot", { format: "png", ...(clip && { clip }) })).data as string;
    };
    const data = fixture ? await stillFrame(capture) : await capture();
    const png = Buffer.from(data, "base64");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, metadata ? withPngMetadata(png, metadata) : png);
    console.log(`Saved ${file}`);
  };
  return { evaluate, shoot };
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * What an image was captured from, stored inside it. `fixture` and `capture`
 * must match for two images to be compared; `build`, `data` and `browser`
 * identify what differs when they don't look the same.
 */
async function fixtureMetadata(base: string, cdp: Cdp) {
  const { product } = await cdp.send("Browser.getVersion");
  return {
    fixture: FIXTURE,
    capture: { path, size, media, target, steps: steps.filter((s) => s.op !== "shot") },
    build: sha256(readFileSync(join(root, "web", "dist", "index.html"))),
    data: sha256(await (await fetch(`${base}/api/tasks`)).text()),
    browser: product as string,
  };
}

async function click(page: PageCommand, evaluate: Evaluate, selector: string) {
  const box = await waitFor(selector, () =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`),
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await page("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
}

async function runSteps(page: PageCommand, tools: ReturnType<typeof pageTools>) {
  const { evaluate, shoot } = tools;
  for (const { op, arg } of steps) {
    if (op === "wait-for") await waitFor(arg, () => evaluate(`!!document.querySelector(${JSON.stringify(arg)})`));
    else if (op === "click") await click(page, evaluate, arg);
    else if (op === "type") await page("Input.insertText", { text: arg });
    else if (op === "key") {
      for (const type of ["keyDown", "keyUp"]) await page("Input.dispatchKeyEvent", { type, key: arg, code: arg });
    } else if (op === "scroll") {
      const [sel, px] = arg.split(/=(?=[^=]*$)/) as [string, string];
      await evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollTop = ${Number(px)}`);
    } else if (op === "scroll-to") {
      await evaluate(`document.querySelector(${JSON.stringify(arg)}).scrollIntoView({ block: "center", behavior: "instant" })`);
    } else if (op === "sleep") await new Promise((r) => setTimeout(r, Number(arg)));
    else if (op === "eval") console.log(JSON.stringify(await evaluate(arg), null, 2));
    else if (op === "shot") await shoot(resolve(arg));
    // Let animations and layout effects settle before the next step.
    await new Promise((r) => setTimeout(r, 350));
  }
}

async function closeBrowser({ chrome, cdp, crashed }: ReturnType<typeof launchBrowser>) {
  // Close the browser before its profile directory is removed.
  chrome.off("exit", crashed);
  const exited = new Promise((r) => chrome.once("exit", r));
  await cdp.send("Browser.close").catch(() => {});
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
}

async function main() {
  const base = fixture ? await bootFixture() : (origin ?? (await bootDemo()));
  const browser = launchBrowser();
  const page = await configurePage(browser.cdp);
  const metadata = fixture ? await fixtureMetadata(base, browser.cdp) : null;
  const tools = pageTools(page, metadata);
  const loaded = browser.cdp.once("Page.loadEventFired");
  await page("Page.navigate", { url: base + path });
  await loaded;
  await tools.evaluate("document.fonts.ready.then(() => true)");
  await runSteps(page, tools);
  await tools.shoot(out);
  await closeBrowser(browser);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
