import type { Hono } from "hono";
import { RUNNER_LIMITS } from "@crane/contracts";
import type { NewRunnerInput } from "@crane/factory/actions";
import { signedInActor } from "../auth.js";
import { boundedJsonObject } from "../body.js";
import type { RouteDeps } from "./deps.js";
import { taskPayloads } from "./task-payloads.js";

/** Operators can manage containers and route tasks. The actions check ownership and admin permissions. */
export function registerRunnersRoutes(api: Hono, { actions }: RouteDeps): void {
  api.get("/runners", (c) => c.json(actions.listRunners(signedInActor(c))));
  api.post("/runners", async (c) => {
    const by = signedInActor(c);
    const input = await boundedJsonObject<NewRunnerInput>(c.req.raw, RUNNER_LIMITS.controlBytes);
    return c.json(actions.addRunner(by, input), 201, { "cache-control": "no-store" });
  });
  api.patch("/runners/:id", async (c) => {
    const by = signedInActor(c);
    const patch = await boundedJsonObject(c.req.raw, RUNNER_LIMITS.controlBytes);
    return c.json(actions.updateRunner(by, c.req.param("id"), patch));
  });
  api.post("/runners/:id/rotate", (c) => {
    const issued = actions.rotateRunnerToken(signedInActor(c), c.req.param("id"));
    return c.json(issued, 200, { "cache-control": "no-store" });
  });
  api.delete("/runners/:id", (c) => {
    actions.removeRunner(signedInActor(c), c.req.param("id"));
    return c.body(null, 204);
  });
  api.put("/tasks/:id/runner", async (c) => {
    const by = signedInActor(c);
    const { runnerId } = await boundedJsonObject<{ runnerId?: string | null }>(c.req.raw, RUNNER_LIMITS.controlBytes);
    if (runnerId === undefined) return c.json({ error: "Give runnerId, or null to clear the container" }, 400);
    return c.json(taskPayloads(actions)(actions.setTaskRunner(by, c.req.param("id"), runnerId)));
  });
  api.get("/settings/runners-required", (c) => c.json({ value: actions.runnersRequired(signedInActor(c)) }));
  api.put("/settings/runners-required", async (c) => {
    const by = signedInActor(c);
    const { value } = await boundedJsonObject<{ value?: unknown }>(c.req.raw, RUNNER_LIMITS.controlBytes);
    return c.json({ value: actions.setRunnersRequired(by, value) });
  });
}
