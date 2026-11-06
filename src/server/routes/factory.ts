import type { Hono } from "hono";
import type { RouteDeps } from "./deps.js";

/** Factory-wide settings: agents and their defaults, post-mortems, retention, and pausing. */
export function registerFactoryRoutes(api: Hono, { actions, factoryState }: RouteDeps): void {
  /** The agents tasks can run on (Claude Code, Codex, …) and which one is the default. */
  api.get("/drivers", async (c) => c.json(await actions.drivers()));
  /** The model and effort one agent runs with. */
  api.post("/drivers/:name", async (c) => c.json(await actions.configureDriver(c.req.param("name"), await c.req.json())));
  api.post("/factory/driver", async (c) => {
    const { driver } = await c.req.json<{ driver: string }>();
    return c.json(await actions.setDefaultDriver(driver));
  });
  api.get("/factory/postmortem", (c) => c.json(actions.postmortemSettings()));
  api.get("/factory/retention", (c) => c.json(actions.retentionSettings()));
  api.post("/factory/retention", async (c) => c.json(actions.configureRetention(await c.req.json())));
  api.post("/factory/postmortem", async (c) => c.json(actions.configurePostmortem(await c.req.json())));

  api.post("/factory/pause", (c) => {
    actions.pause();
    return c.json(factoryState());
  });
  api.post("/factory/resume", (c) => {
    actions.resume();
    return c.json(factoryState());
  });
}
