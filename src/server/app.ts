import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Store } from "../core/store.js";
import type { MissionStatus, NewMission } from "../core/types.js";
import { OperatorActions } from "../factory/actions.js";
import { draftMission } from "../factory/instruct.js";
import { diffForMission } from "../factory/git.js";
import { factoryDriverName, factoryIsRunning } from "../factory/orchestrator.js";
import { factoryRoot } from "../core/paths.js";

export function createApp(store: Store) {
  const app = new Hono();
  const actions = new OperatorActions(store);

  const factoryState = () => ({
    running: factoryIsRunning(store),
    paused: store.isPaused(),
    driver: factoryDriverName(store),
  });

  app.onError((err, c) => c.json({ error: err.message }, 400));

  const api = new Hono();

  api.get("/overview", (c) => c.json(store.overview(factoryState())));

  api.get("/missions", (c) => {
    const status = c.req.query("status")?.split(",").filter(Boolean) as MissionStatus[] | undefined;
    const repoId = c.req.query("repo") || undefined;
    return c.json(store.listMissions({ status, repoId }));
  });

  api.get("/missions/:id", (c) => {
    const m = store.getMission(c.req.param("id"));
    if (!m) return c.json({ error: "Not found" }, 404);
    const repo = m.repoId ? store.getRepo(m.repoId) : null;
    const agent = m.agentId ? store.listAgents().find((a) => a.id === m.agentId) ?? null : null;
    return c.json({ mission: m, repo, agent, events: store.listEvents(m.id) });
  });

  api.get("/missions/:id/diff", async (c) => {
    const m = store.getMission(c.req.param("id"));
    const repo = m?.repoId ? store.getRepo(m.repoId) : null;
    if (!m || !repo) return c.json({ diff: "" });
    return c.json({ diff: await diffForMission(repo, m) });
  });

  /** Live events for one mission, or for the whole factory when id is "all". */
  api.get("/missions/:id/stream", (c) => {
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
    return c.json(draftMission(text ?? "", store.listRepos()));
  });

  api.post("/missions", async (c) => {
    const body = await c.req.json<NewMission>();
    return c.json(actions.createMission(body), 201);
  });

  api.post("/missions/:id/approve", async (c) => {
    const { note } = await c.req.json<{ note?: string }>().catch(() => ({ note: undefined }));
    return c.json(await actions.approve(c.req.param("id"), note));
  });
  api.post("/missions/:id/reject", async (c) => {
    const { note } = await c.req.json<{ note?: string }>().catch(() => ({ note: undefined }));
    return c.json(await actions.reject(c.req.param("id"), note));
  });
  api.post("/missions/:id/cancel", (c) => c.json(actions.cancel(c.req.param("id"))));
  api.post("/missions/:id/retry", (c) => c.json(actions.retry(c.req.param("id")), 201));
  api.post("/missions/:id/follow-up", async (c) => {
    const { finding } = await c.req.json<{ finding: number }>();
    return c.json(actions.followUp(c.req.param("id"), finding), 201);
  });

  api.get("/repos", (c) => c.json(store.listRepos()));
  api.post("/repos", async (c) => {
    const { path, name } = await c.req.json<{ path: string; name?: string }>();
    return c.json(await actions.connectRepo(path, name), 201);
  });
  api.delete("/repos/:id", (c) => {
    store.removeRepo(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/agents", (c) => c.json(store.listAgents()));

  api.post("/factory/pause", (c) => {
    actions.pause();
    return c.json(factoryState());
  });
  api.post("/factory/resume", (c) => {
    actions.resume();
    return c.json(factoryState());
  });

  app.route("/api", api);

  // Serve the built web app, if there is one.
  const webDist = join(factoryRoot(), "web", "dist");
  if (existsSync(webDist)) {
    app.use("/*", serveStatic({ root: relative(process.cwd(), webDist) || "." }));
    // Read per request so a rebuilt UI is picked up without restarting the factory.
    app.get("*", (c) => c.html(readFileSync(join(webDist, "index.html"), "utf8")));
  } else {
    app.get("/", (c) =>
      c.text("Crane's API is running. Build the web app with `npm run build`, or run `npm run dev` for the live UI on :5173."),
    );
  }

  return app;
}
