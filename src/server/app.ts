import { Hono } from "hono";
import type { Store } from "../core/store.js";
import { OperatorActions } from "../factory/actions.js";
import { factoryState } from "../factory/state.js";
import { refuseUntrusted } from "./security.js";
import { registerDashboard } from "./static.js";
import type { RegisterRoutes, RouteDeps } from "./routes/deps.js";
import { overviewCache, registerOverviewRoutes } from "./routes/overview.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTaskDecisionRoutes } from "./routes/task-decisions.js";
import { registerGoalRoutes } from "./routes/goals.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerCrewRoutes } from "./routes/crew.js";
import { registerFactoryRoutes } from "./routes/factory.js";

export { isLoopbackAddress } from "./security.js";

/** In registration order. Hono tries routes in this order, so `/tasks/queue` stays ahead of `/tasks/:id`. */
const ROUTES: RegisterRoutes[] = [
  registerTaskRoutes, registerGoalRoutes, registerTaskDecisionRoutes,
  registerRepoRoutes, registerCrewRoutes, registerFactoryRoutes,
];

/**
 * The dashboard's HTTP server: the refusal check before anything else, the API under `/api`, then the built web app.
 * Errors an action throws answer 400 with their message.
 */
export function createApp(store: Store, opts: { exposed?: boolean } = {}) {
  const app = new Hono();
  const deps: RouteDeps = { store, actions: new OperatorActions(store), factoryState: () => factoryState(store) };

  app.onError((err, c) => c.json({ error: err.message }, 400));
  app.use("*", refuseUntrusted(opts.exposed ?? false));

  const api = new Hono();
  const cache = overviewCache();
  api.use("*", cache.invalidate);
  registerOverviewRoutes(api, deps, cache);
  for (const register of ROUTES) register(api, deps);
  app.route("/api", api);

  registerDashboard(app);
  return app;
}
