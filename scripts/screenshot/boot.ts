/**
 * The factories scripts/screenshot.ts captures: a throwaway live demo or the repeatable fixture, each in its own
 * temporary CRANE_HOME, plus the process bookkeeping that tears them down when the script exits.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { webBuildOutdated } from "@crane/backend-runtime";
import { FIXTURE_NODE_ARGS, createFixtureHome, fixtureEnv } from "../fixture/fixture.ts";

export const root = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
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
process.on("exit", () => {
  for (const c of children) c.kill("SIGTERM");
  for (const f of cleanup) {
    try {
      f();
    } catch {
      // A temp dir left behind is harmless.
    }
  }
});

/** Stop this process when the script exits. */
export const track = (child: ChildProcess) => void children.push(child);
/** Remove this temporary directory when the script exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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

/**
 * Ready once the public session route answers. Unlike /api/overview it needs no session, so the probe works the
 * same whether or not the factory requires sign-in.
 */
const ready = (url: string, what: string) => waitFor(what, () => fetch(`${url}/api/auth/session`).then((r) => r.ok));

export type Credentials = { username: string; password: string };

/** Add an admin to the demo's home through the host CLI, the way an operator creates the first one. */
function addOperator(env: NodeJS.ProcessEnv, { username, password }: Credentials) {
  const args = ["--import", "tsx", "src/cli/index.ts", "operators", "add", username, "--admin", "--password-stdin"];
  try {
    execFileSync(process.execPath, args, { cwd: root, env, input: `${password}\n`, stdio: ["pipe", "ignore", "pipe"] });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
    fail(`Couldn't add the operator ${username}${stderr ? `: ${stderr}` : ""}`);
  }
}

/** A seeded demo factory with simulated agents. With `operator`, that admin exists before serve, so sign-in is required. */
export async function bootDemo(operator: Credentials | null): Promise<string> {
  if (!existsSync(join(root, "web", "dist", "index.html"))) fail("Build the UI first: npm run build -w web");
  const home = tempDir("crane-shot-");
  const env = { ...process.env, CRANE_HOME: home };
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-demo.ts"], { cwd: root, env, stdio: "ignore" });
  if (operator) addOperator(env, operator);
  const port = await freePort();
  // --no-build-dashboard: screenshot this checkout's web/dist, never a build of its default branch.
  const args = ["serve", "--port", String(port), "--driver", "simulated", "--no-build-dashboard"];
  const server = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], { cwd: root, env, stdio: "ignore" });
  track(server);
  // The factory listens on 127.0.0.1; "localhost" can resolve to ::1 first.
  const url = `http://127.0.0.1:${port}`;
  await ready(url, "the demo factory");
  return url;
}

/** Like bootDemo, with the seed and server pinned and no factory process. */
export async function bootFixture(): Promise<string> {
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
  track(server);
  server.on("exit", (code) => fail(`The fixture server exited (${code}) before the screenshot.`));
  const url = `http://127.0.0.1:${port}`;
  await ready(url, "the fixture server");
  return url;
}
