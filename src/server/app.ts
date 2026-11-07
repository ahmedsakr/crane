import { Hono } from "hono";
import type { Store } from "../core/store.js";
import { OperatorActions } from "../factory/actions.js";
import { factoryState } from "../factory/state.js";
import { apiAccess, errorResponse, requireSignIn, type AccessOptions } from "./auth.js";
import { refuseUntrusted } from "./security.js";
import { registerDashboard } from "./static.js";
import type { RegisterRoutes, RouteDeps } from "./routes/deps.js";
import { overviewCache, registerOverviewRoutes } from "./routes/overview.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTaskDecisionRoutes } from "./routes/task-decisions.js";
import { registerGoalRoutes } from "./routes/goals.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerCrewRoutes } from "./routes/crew.js";
import { registerFactoryRoutes } from "./routes/factory.js";

export { isLoopbackAddress } from "./security.js";

/** In registration order. Hono tries routes in this order, so `/tasks/queue` stays ahead of `/tasks/:id`. */
const ROUTES: RegisterRoutes[] = [
  registerAuthRoutes, registerTaskRoutes, registerGoalRoutes, registerTaskDecisionRoutes,
  registerRepoRoutes, registerCrewRoutes, registerFactoryRoutes,
];

export type AppOptions = AccessOptions;

/**
 * The dashboard's HTTP server: the refusal check before anything else, then the API under `/api` behind the
 * sign-in gate, then the built web app, which stays public. Refusals about who is asking answer with their own
 * status; any other error an action throws answers 400 with its message.
 */
export function createApp(store: Store, opts: AppOptions = {}) {
  const app = new Hono();
  const actions = new OperatorActions(store, opts.clock);
  const access = apiAccess(actions, opts);
  const deps: RouteDeps = { store, actions, factoryState: () => factoryState(store), access };

  app.onError(errorResponse);
  app.use("*", refuseUntrusted(access.exposed));

  const api = new Hono();
  // Ahead of the shared overview and every route, so nothing cached or routed answers a request without a session.
  api.use("*", requireSignIn(access));
  const cache = overviewCache();
  api.use("*", cache.invalidate);
  registerOverviewRoutes(api, deps, cache);
  for (const register of ROUTES) register(api, deps);
  app.route("/api", api);

  registerDashboard(app);
  return app;
}
