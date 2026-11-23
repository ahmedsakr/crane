import { Hono } from "hono";
import type { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { factoryState } from "@crane/factory/state";
import { apiAccess, errorResponse, requireSignIn, type AccessOptions } from "./auth.js";
import { refuseUntrusted, secureResponses } from "./security.js";
import { registerDashboard } from "./static.js";
import type { RegisterRoutes, RouteDeps } from "./routes/deps.js";
import { overviewCache, registerOverviewRoutes } from "./routes/overview.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOperatorsRoutes } from "./routes/operators.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTaskDecisionRoutes } from "./routes/task-decisions.js";
import { registerGoalRoutes } from "./routes/goals.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerCrewRoutes } from "./routes/crew.js";
import { registerFactoryRoutes } from "./routes/factory.js";
import { registerRunnerRoutes } from "./routes/runner.js";
import { registerRunnersRoutes } from "./routes/runners.js";
import { requireRunner } from "./runner-auth.js";

/** In registration order. Hono tries routes in this order, so `/tasks/queue` stays ahead of `/tasks/:id`. */
const ROUTES: RegisterRoutes[] = [
  registerAuthRoutes, registerOperatorsRoutes, registerTaskRoutes, registerGoalRoutes, registerTaskDecisionRoutes,
  registerRepoRoutes, registerCrewRoutes, registerFactoryRoutes, registerRunnerRoutes, registerRunnersRoutes,
];

export type AppOptions = AccessOptions;

/**
 * The dashboard's HTTP server checks the request before either API gate. The built web app stays public.
 *
 * The application (`src/application.ts`) must bind its identity before requests arrive: the dashboard, the overview's
 * build status and dashboard builds all read it, and this package never imports the application itself.
 */
export function createApp(store: Store, opts: AppOptions = {}) {
  const app = new Hono();
  const actions = new OperatorActions(store, opts.clock);
  const access = apiAccess(actions, opts);
  const deps: RouteDeps = { store, actions, factoryState: () => factoryState(store), access };

  app.onError(errorResponse);
  // First, so refusals carry the security headers too.
  app.use("*", secureResponses(access));
  app.use("*", refuseUntrusted(access));

  const api = new Hono();
  // Both gates run before the shared overview cache and API routes.
  api.use("*", requireSignIn(access));
  api.use("/runner/*", requireRunner(access));
  const cache = overviewCache();
  api.use("*", cache.invalidate);
  registerOverviewRoutes(api, deps, cache);
  for (const register of ROUTES) register(api, deps);
  app.route("/api", api);

  registerDashboard(app);
  return app;
}
