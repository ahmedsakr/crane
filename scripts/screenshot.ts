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
 *   --size <WxH>      viewport, default 1280x800
 *   --media <f>=<v>   emulate a media feature for the whole run, like
 *                     prefers-color-scheme=dark or prefers-reduced-motion=reduce (repeatable)
 *   --wait-for <sel>  wait until a selector exists
 *   --click <sel>     click the first match with a real mouse event
 *   --type <text>     type into the focused element
 *   --key <key>       press a key, like Escape or Enter
 *   --scroll <sel>=<px>  set scrollTop on the first match
 *   --sleep <ms>      wait
 *   --eval <js>       run an expression and print its JSON result
 *   --shot <file>     take a screenshot now (repeatable)
 *   --out <file>      final screenshot, default .crane/screenshot.png
 *
 * Finds Chromium on PATH, in Playwright's cache, or at $CRANE_CHROMIUM.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

type Step = { op: string; arg: string };
const args = process.argv.slice(2);
let path = "/";
let origin: string | null = null;
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
  else if (a === "--size") size = next();
  else if (a === "--media") {
    const [name, value] = next().split("=");
    if (!name || !value) fail(`--media should look like prefers-color-scheme=dark`);
    media.push({ name, value });
  }
  else if (a === "--out") out = resolve(next());
  else if (["--wait-for", "--click", "--type", "--key", "--scroll", "--sleep", "--eval", "--shot"].includes(a))
    steps.push({ op: a.slice(2), arg: next() });
  else if (a.startsWith("--")) fail(`Unknown option ${a}`);
  else path = a.startsWith("/") ? a : `/${a}`;
}
const [width, height] = size.split("x").map(Number) as [number, number];
if (!width || !height) fail(`--size should look like 1280x800, got ${size}`);

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

async function main() {
  const base = origin ?? (await bootDemo());
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

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method: string, params: object = {}) => cdp.send(method, params, sessionId);
  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  if (media.length) await page("Emulation.setEmulatedMedia", { features: media });

  const evaluate = async (expression: string) => {
    const r = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const shoot = async (file: string) => {
    const { data } = await page("Page.captureScreenshot", { format: "png" });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`Saved ${file}`);
  };

  const loaded = cdp.once("Page.loadEventFired");
  await page("Page.navigate", { url: base + path });
  await loaded;
  await evaluate("document.fonts.ready.then(() => true)");

  for (const { op, arg } of steps) {
    if (op === "wait-for") await waitFor(arg, () => evaluate(`!!document.querySelector(${JSON.stringify(arg)})`));
    else if (op === "click") {
      const box = await waitFor(arg, () =>
        evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(arg)});
          if (!el) return null;
          el.scrollIntoView({ block: "nearest" });
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`),
      );
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await page("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
    } else if (op === "type") await page("Input.insertText", { text: arg });
    else if (op === "key") {
      for (const type of ["keyDown", "keyUp"]) await page("Input.dispatchKeyEvent", { type, key: arg, code: arg });
    } else if (op === "scroll") {
      const [sel, px] = arg.split(/=(?=[^=]*$)/) as [string, string];
      await evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollTop = ${Number(px)}`);
    } else if (op === "sleep") await new Promise((r) => setTimeout(r, Number(arg)));
    else if (op === "eval") console.log(JSON.stringify(await evaluate(arg), null, 2));
    else if (op === "shot") await shoot(resolve(arg));
    // Let animations and layout effects settle before the next step.
    await new Promise((r) => setTimeout(r, 350));
  }
  await shoot(out);

  // Close the browser before its profile directory is removed.
  chrome.off("exit", crashed);
  const exited = new Promise((r) => chrome.once("exit", r));
  await cdp.send("Browser.close").catch(() => {});
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
