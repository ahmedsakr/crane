import type { Hono } from "hono";
import type { NewGoal, TaskRunOptions } from "@crane/contracts";
import { goalListItems } from "../../core/store/goal-progress.js";
import { optionalJsonObject } from "../body.js";
import type { RouteDeps } from "./deps.js";

type RevisedRun = TaskRunOptions & { revision: unknown };

export function registerGoalRoutes(api: Hono, { store, actions }: RouteDeps): void {
  api.get("/goals", (c) => { store.syncGoals(); return c.json(goalListItems(store)); });
  api.get("/goals/:id", (c) => {
    store.syncGoals();
    if (!store.getGoal(c.req.param("id"))) return c.json({ error: "Not found" }, 404);
    return c.json(store.goalDetail(c.req.param("id")));
  });
  api.post("/goals", async (c) => c.json(actions.createGoal(await optionalJsonObject<NewGoal>(c.req.raw)), 201));
  api.post("/goals/:id/feedback", async (c) => {
    const body = await optionalJsonObject<{ revision: unknown; feedback: unknown }>(c.req.raw);
    return c.json(actions.reviseGoal(c.req.param("id"), body.revision, body.feedback));
  });
  api.put("/goals/:id/plan", async (c) => {
    const body = await optionalJsonObject<{ revision: unknown; plan: unknown }>(c.req.raw);
    return c.json(actions.editGoalPlan(c.req.param("id"), body.revision, body.plan));
  });
  api.post("/goals/:id/approve", async (c) => {
    const body = await optionalJsonObject<{ revision: unknown; autoMerge?: unknown }>(c.req.raw);
    return c.json(actions.approveGoal(c.req.param("id"), body.revision, body.autoMerge));
  });
  api.post("/goals/:id/cancel", async (c) => {
    const body = await optionalJsonObject<{ revision: unknown }>(c.req.raw);
    return c.json(actions.cancelGoal(c.req.param("id"), body.revision));
  });
  api.post("/goals/:id/tasks/:taskId/retry", async (c) => {
    const { revision, driver, model, effort } = await optionalJsonObject<RevisedRun>(c.req.raw);
    return c.json(actions.retryGoalTask(c.req.param("id"), revision, c.req.param("taskId"), { driver, model, effort }));
  });
  api.post("/goals/:id/plan/tasks/:key/agent", async (c) => {
    const { revision, driver, model, effort } = await optionalJsonObject<RevisedRun>(c.req.raw);
    return c.json(actions.changeGoalPlanAgent(c.req.param("id"), revision, c.req.param("key"), { driver, model, effort }));
  });
}
