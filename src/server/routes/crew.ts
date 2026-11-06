import type { Hono } from "hono";
import type { RoleRunOptions } from "@crane/contracts";
import { optionalJsonObject } from "../body.js";
import type { RouteDeps } from "./deps.js";

/** Crew members, their maintenance runs, and their recurring schedules. */
export function registerCrewRoutes(api: Hono, { store, actions }: RouteDeps): void {
  api.post("/agents/:id", async (c) => c.json(await actions.configureCrew(c.req.param("id"), await c.req.json())));
  /** Start a crew member's maintenance run, assigned to them. */
  api.post("/agents/:id/run", async (c) => c.json(await actions.runRole(c.req.param("id"), await optionalJsonObject<RoleRunOptions>(c.req.raw)), 201));
  api.get("/agents", (c) => c.json(store.listAgents()));
  api.get("/crew/schedules", (c) => c.json(actions.listCrewSchedules()));
  api.get("/agents/:id/schedules", (c) => c.json(actions.listCrewSchedules(c.req.param("id"))));
  api.post("/agents/:id/schedules", async (c) => c.json(actions.saveCrewSchedule(c.req.param("id"), await c.req.json()), 201));
  api.post("/agents/:id/schedules/:scheduleId", async (c) => c.json(actions.saveCrewSchedule(c.req.param("id"), await c.req.json(), c.req.param("scheduleId"))));
  api.delete("/agents/:id/schedules/:scheduleId", (c) => {
    actions.removeCrewSchedule(c.req.param("id"), c.req.param("scheduleId"));
    return c.json({ ok: true });
  });
}
