import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getMimeType } from "hono/utils/mime";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Store } from "../core/store.js";
import { lastMergeOutcome, type TaskStatus, type NewTask, type TaskDetail, type TaskDraft } from "../core/types.js";
import { OperatorActions } from "../factory/actions.js";
import { draftTask } from "../factory/instruct.js";
import { diffForTask } from "../factory/git.js";
import { factoryState as readFactoryState } from "../factory/orchestrator.js";
import { servedDashboard } from "../core/webbuild.js";

/** Empty bodies use action defaults; malformed or non-object JSON must never trigger a decision. */
async function optionalJsonObject<T extends object>(request: Request): Promise<T> {
  const text = await request.text();
  const body: unknown = text === "" ? {} : JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
  return body as T;
}

export function createApp(store: Store) {
  const app = new Hono();
  const actions = new OperatorActions(store);
  const factoryState = () => readFactoryState(store);

  app.onError((err, c) => c.json({ error: err.message }, 400));

  const api = new Hono();

  api.get("/overview", (c) => c.json(store.overview(factoryState())));

  api.get("/tasks", (c) => {
    const status = c.req.query("status")?.split(",").filter(Boolean) as TaskStatus[] | undefined;
    const repoId = c.req.query("repo") || undefined;
    return c.json(store.listTasks({ status, repoId }));
  });

  api.get("/tasks/:id", (c) => {
    const m = store.getTask(c.req.param("id"));
    if (!m) return c.json({ error: "Not found" }, 404);
    const repo = m.repoId ? store.getRepo(m.repoId) : null;
    // Who's working it, or, before it's picked up, the crew member it was started for.
    const agentId = m.agentId ?? (m.status === "queued" ? m.assignee : null);
    const agent = agentId ? store.listAgents().find((a) => a.id === agentId) ?? null : null;
    // Commands this task was refused that are still waiting on a decision, counted across the repo's tasks.
    const blocked = store.blockedTools({ taskId: m.id, ...(m.repoId ? { repoId: m.repoId } : {}) });
    const detail: TaskDetail = { task: m, repo, agent, events: store.listEvents(m.id), runs: store.listRuns(m.id), blocked };
    return c.json(detail);
  });

  api.get("/analytics", (c) => c.json(store.analytics(Number(c.req.query("days") ?? 30))));

  api.get("/tasks/:id/diff", async (c) => {
    const m = store.getTask(c.req.param("id"));
    const repo = m?.repoId ? store.getRepo(m.repoId) : null;
    if (!m || !repo) return c.json({ diff: "" });
    const merged = m.status === "merged" ? lastMergeOutcome(store.listEvents(m.id))?.commit : null;
    return c.json({ diff: await diffForTask(repo, m, merged) });
  });

  /** Live events for one task, or for the whole factory when id is "all". */
  api.get("/tasks/:id/stream", (c) => {
    const id = c.req.param("id");
    let cursor = Number(c.req.query("after") ?? (id === "all" ? store.latestEventId() : 0));
    return streamSSE(c, async (stream) => {
      let alive = true;
      stream.onAbort(() => {
        alive = false;
      });
      while (alive) {
        const events = id === "all" ? store.eventsSince(cursor) : store.listEvents(id, cursor);
        for (const e of events) {
          await stream.writeSSE({ data: JSON.stringify(e), event: "event", id: String(e.id) });
          cursor = e.id;
        }
        await stream.sleep(events.length ? 50 : 500);
      }
    });
  });

  api.post("/instruct/draft", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    const draft: TaskDraft = draftTask(text ?? "", store.listRepos(), { lastRepoId: store.getSetting("last_repo") });
    return c.json(draft);
  });

  api.post("/tasks", async (c) => {
    const body = await c.req.json<NewTask>();
    return c.json(actions.createTask(body), 201);
  });

  api.post("/tasks/:id/approve", async (c) => {
    const { note, merge } = await optionalJsonObject<{ note?: string; merge?: boolean }>(c.req.raw);
    return c.json(await actions.approve(c.req.param("id"), note, { merge }));
  });
  api.post("/tasks/:id/merge", async (c) => c.json(await actions.merge(c.req.param("id"))));
  api.post("/tasks/:id/reject", async (c) => {
    const { note } = await optionalJsonObject<{ note?: string }>(c.req.raw);
    return c.json(await actions.reject(c.req.param("id"), note));
  });
  api.post("/tasks/:id/cancel", (c) => c.json(actions.cancel(c.req.param("id"))));
  api.post("/tasks/:id/retry", async (c) => {
    const body = await optionalJsonObject<{ driver?: string | null }>(c.req.raw);
    return c.json(actions.retry(c.req.param("id"), { driver: body.driver }), 201);
  });
  api.post("/tasks/:id/follow-up", async (c) => {
    const { finding } = await c.req.json<{ finding: number }>();
    return c.json(actions.followUp(c.req.param("id"), finding), 201);
  });

  api.get("/repos", (c) => c.json(store.listRepos()));
  api.get("/repos/:id/checks", (c) => c.json(store.repoChecks(c.req.param("id"))));
  api.put("/repos/:id/checks", async (c) => {
    const commands: unknown = await c.req.json();
    if (!store.getRepo(c.req.param("id"))) return c.json({ error: "No such repo" }, 404);
    if (!Array.isArray(commands) || commands.some(x => typeof x !== "string" || !x.trim())) {
      return c.json({ error: "Expected an array of nonempty commands" }, 400);
    }
    store.setRepoChecks(c.req.param("id"), commands);
    return c.json(commands);
  });
  api.post("/repos", async (c) => {
    const { path, name } = await c.req.json<{ path: string; name?: string }>();
    return c.json(await actions.connectRepo(path, name), 201);
  });
  api.delete("/repos/:id", (c) => {
    store.removeRepo(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/blocked", (c) =>
    c.json(store.blockedTools({ repoId: c.req.query("repo") || undefined, minTasks: Number(c.req.query("min") ?? 1) })),
  );
  api.post("/repos/:id/tools/allow", async (c) => {
    const { rule, taskId } = await c.req.json<{ rule: string; taskId?: string }>();
    return c.json(actions.allowTool(c.req.param("id"), rule, taskId));
  });
  api.post("/repos/:id/tools/keep-blocked", async (c) => {
    const { rule, taskId } = await c.req.json<{ rule: string; taskId?: string }>();
    return c.json(actions.keepBlocked(c.req.param("id"), rule, taskId));
  });
  api.post("/repos/:id/tools/disallow", async (c) => {
    const { rule } = await c.req.json<{ rule: string }>();
    return c.json(actions.disallowTool(c.req.param("id"), rule));
  });

  api.post("/agents/:id", async (c) => c.json(await actions.configureCrew(c.req.param("id"), await c.req.json())));
  /** Start a crew member's maintenance run, assigned to them. */
  api.post("/agents/:id/run", async (c) => c.json(await actions.runRole(c.req.param("id")), 201));
  api.get("/agents", (c) => c.json(store.listAgents()));

  /** The agents tasks can run on (Claude Code, Codex, …) and which one is the default. */
  api.get("/drivers", async (c) => c.json(await actions.drivers()));
  /** The model and effort one agent runs with. */
  api.post("/drivers/:name", async (c) => c.json(await actions.configureDriver(c.req.param("name"), await c.req.json())));
  api.post("/factory/driver", async (c) => {
    const { driver } = await c.req.json<{ driver: string }>();
    return c.json(await actions.setDefaultDriver(driver));
  });

  api.post("/factory/pause", (c) => {
    actions.pause();
    return c.json(factoryState());
  });
  api.post("/factory/resume", (c) => {
    actions.resume();
    return c.json(factoryState());
  });

  app.route("/api", api);

  // Serve the newest built web app: Crane's own build of the latest merge, or
  // the checkout's web/dist. Chosen per request, so a new build is picked up
  // without restarting the factory.
  app.get("*", (c) => {
    const served = servedDashboard();
    if (!served) {
      return c.text("Crane's API is running. Build the web app with `npm run build`, or run `npm run dev` for the live UI on :5173.");
    }
    const file = staticFile(c.req.path, [served.dir, ...served.fallbacks]);
    if (file) {
      return c.body(readFileSync(file), 200, {
        "content-type": getMimeType(file) ?? "application/octet-stream",
        // Bundles are named by their content, so they never change.
        ...(c.req.path.startsWith("/assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
      });
    }
    if (c.req.path.startsWith("/assets/")) return c.text("Not found", 404);
    // Everything else is a page of the app. Never cached, so a reload gets the newest build.
    return c.html(readFileSync(join(served.dir, "index.html"), "utf8"), 200, { "cache-control": "no-cache" });
  });

  return app;
}

/**
 * The file a request path names in the first of `dirs` that has it. Only
 * files inside those directories, never `index.html` (pages are handled apart).
 * Older builds come after the served one, so a page that's still open from
 * before a new build can finish loading its assets.
 */
function staticFile(path: string, dirs: string[]): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (rel === "/" || rel.endsWith("/") || rel === "/index.html" || rel.includes("\0")) return null;
  for (const dir of dirs) {
    const file = resolve(dir, `.${rel}`);
    if (!file.startsWith(dir + sep)) continue;
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // Not in this build.
    }
  }
  return null;
}
