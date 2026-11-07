import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { createApp } from "../../src/server/app.js";

/**
 * Calling the API with `app.request()`, without sockets. Clients name themselves with `x-client`, which the tests'
 * `clientKey` reads, so one test can act from several.
 */

export type App = ReturnType<typeof createApp>;
export type Call = { cookie?: string; body?: unknown; client?: string; headers?: Record<string, string> };

/** The note `openStream` reads up to. */
export const NOTE = "Hello from the factory";

export function call(app: App, method: string, path: string, opts: Call = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.client) headers["x-client"] = opts.client;
  const body = method === "GET" ? undefined : JSON.stringify(opts.body ?? {});
  return Promise.resolve(app.request(path, { method, headers, body }));
}

/** The `crane_session=…` pair a response sets. */
export function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  assert.match(set, /^crane_session=[^;]+;/);
  return set.split(";")[0]!;
}

/** Open a task's event stream and read it up to the note `NOTE`; `ended` settles once the server closes it. */
export async function openStream(app: App, taskId: string, cookie?: string) {
  const res = await call(app, "GET", `/api/tasks/${taskId}/stream?after=0`, { cookie });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(NOTE)) {
    const chunk = await reader.read();
    assert.ok(!chunk.done, `the stream ended before ${NOTE}: ${seen}`);
    seen += decoder.decode(chunk.value, { stream: true });
  }
  const ended = (async () => {
    while (!(await reader.read()).done) { /* later events */ }
    return "ended";
  })();
  return { reader, ended };
}

/** "open" unless `promise` settles within `ms`. */
export const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, sleep(ms).then(() => "open")]);
