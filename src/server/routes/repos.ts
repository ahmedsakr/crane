import type { Hono } from "hono";
import type { RouteDeps } from "./deps.js";

/** Connected repositories, their checks, and the command permissions their tasks run with. */
export function registerRepoRoutes(api: Hono, { store, actions }: RouteDeps): void {
  api.get("/repos", (c) => c.json(store.listRepos()));
  api.get("/repos/:id/checks", (c) => {
    const repo = store.getRepo(c.req.param("id"));
    if (!repo) return c.json({ error: "No such repo" }, 404);
    return c.json(store.repoChecks(repo.id));
  });
  api.put("/repos/:id/checks", async (c) => {
    const commands: unknown = await c.req.json();
    if (!store.getRepo(c.req.param("id"))) return c.json({ error: "No such repo" }, 404);
    return c.json(actions.configureChecks(c.req.param("id"), commands));
  });
  api.post("/repos", async (c) => {
    const { path, name } = await c.req.json<{ path: string; name?: string }>();
    return c.json(await actions.connectRepo(path, name), 201);
  });
  api.delete("/repos/:id", (c) => {
    actions.removeRepo(c.req.param("id"));
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
}
