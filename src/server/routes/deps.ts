import type { Hono } from "hono";
import type { Overview } from "@crane/contracts";
import type { Store } from "../../core/store.js";
import type { OperatorActions } from "../../factory/actions.js";

/** What every route module needs. Built once per app by `createApp`. */
export interface RouteDeps {
  store: Store;
  actions: OperatorActions;
  factoryState: () => Overview["factory"];
}

/** Each route module registers its routes on the shared `/api` router, in order. */
export type RegisterRoutes = (api: Hono, deps: RouteDeps) => void;
