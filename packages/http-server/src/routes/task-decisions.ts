import type { Hono } from "hono";
import type { NewTask, TaskGates, TaskRunOptions } from "@crane/contracts";
import { optionalJsonObject } from "../body.js";
import type { RouteDeps } from "./deps.js";
import { taskPayloads } from "./task-payloads.js";

type VisualReviewInput = { status: "inspected" | "waived"; commit: string; note: string };
type FollowUpInput = TaskRunOptions & TaskGates & Pick<NewTask, "lookouts"> & { finding: number };

/** The operator's decisions on one task: review, queue order, scheduling, retries and follow-ups. */
export function registerTaskDecisionRoutes(api: Hono, { store, actions }: RouteDeps): void {
  const payload = <T extends { runnerId: string | null }>(task: T) => taskPayloads(actions)(task);
  api.post("/tasks/:id/approve", async (c) => {
    const { note, merge } = await optionalJsonObject<{ note?: string; merge?: boolean }>(c.req.raw);
    return c.json(payload(await actions.approve(c.req.param("id"), note, { merge })));
  });
  api.post("/tasks/:id/visual-review", async (c) => {
    const input = await optionalJsonObject<VisualReviewInput>(c.req.raw);
    return c.json(payload(await actions.recordVisualReview(c.req.param("id"), input)));
  });
  api.post("/tasks/:id/move", async (c) => {
    const { beforeId } = await optionalJsonObject<{ beforeId: string | null }>(c.req.raw);
    actions.moveQueuedTask(c.req.param("id"), beforeId);
    return c.json(store.listQueuedTaskSummaries().map(taskPayloads(actions)));
  });
  api.post("/tasks/:id/schedule", async (c) => {
    const body = await c.req.json<{ scheduledAt: string | null }>();
    if (!body || typeof body !== "object" || !("scheduledAt" in body)) return c.json({ error: "Give scheduledAt, or null to start now" }, 400);
    return c.json(payload(actions.schedule(c.req.param("id"), body.scheduledAt)));
  });
  api.post("/tasks/:id/pre-approve", async (c) => {
    const { note } = await optionalJsonObject<{ note?: string }>(c.req.raw);
    return c.json(payload(actions.preApprove(c.req.param("id"), note)));
  });
  api.delete("/tasks/:id/pre-approve", (c) => c.json(payload(actions.undoPreApproval(c.req.param("id")))));
  api.post("/tasks/:id/waive-prerequisites", async (c) => {
    const { note } = await optionalJsonObject<{ note?: string }>(c.req.raw);
    return c.json(payload(actions.waivePrerequisites(c.req.param("id"), note)));
  });
  api.post("/tasks/:id/merge", async (c) => c.json(payload(await actions.merge(c.req.param("id")))));
  api.post("/tasks/:id/reject", async (c) => {
    const { note } = await optionalJsonObject<{ note?: string }>(c.req.raw);
    return c.json(payload(await actions.reject(c.req.param("id"), note)));
  });
  api.post("/tasks/:id/cancel", (c) => c.json(payload(actions.cancel(c.req.param("id")))));
  api.post("/tasks/:id/retry", async (c) => {
    const body = await optionalJsonObject<{ driver?: string | null }>(c.req.raw);
    return c.json(payload(actions.retry(c.req.param("id"), { driver: body.driver })), 201);
  });
  api.post("/tasks/:id/follow-up", async (c) => {
    const { finding, ...opts } = await optionalJsonObject<FollowUpInput>(c.req.raw);
    return c.json(payload(actions.followUp(c.req.param("id"), finding, opts)), 201);
  });
}
