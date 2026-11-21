import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { lastMergeOutcome, type NewTask, type Task, type TaskDetail, type TaskDiff, type TaskDraft, type TaskRunOptions, type TaskStatus } from "@crane/contracts";
import type { Store } from "@crane/storage";
import { readScreenshot } from "@crane/storage";
import { draftTask } from "@crane/factory/instruct";
import { diffForTask } from "@crane/factory/diff";
import { admit } from "../auth.js";
import { optionalJsonObject } from "../body.js";
import type { RouteDeps } from "./deps.js";

function taskDetail(store: Store, m: Task): TaskDetail {
  const repo = m.repoId ? store.getRepo(m.repoId) : null;
  // Who's working it, or, before it's picked up, the crew member it was started for.
  const agentId = m.agentId ?? (m.status === "queued" ? m.assignee : null);
  const agent = agentId ? store.listAgents().find((a) => a.id === agentId) ?? null : null;
  // Commands this task was refused that are still waiting on a decision, counted across the repo's tasks.
  const blocked = store.blockedTools({ taskId: m.id, ...(m.repoId ? { repoId: m.repoId } : {}) });
  return {
    goalId: store.goalForTask(m.id),
    task: m, repo, agent, events: store.listEvents(m.id), runs: store.listRuns(m.id), blocked,
    prerequisites: store.prerequisiteStates(m), followUps: store.followUps(m.id),
    followUpSource: store.followUpSource(m),
  };
}

function screenshot(store: Store, c: Context, id: string, name: string) {
  const task = store.getTask(id);
  if (!task?.report?.screenshots?.some(image => image.path === name)) return c.text("Not found", 404);
  const image = readScreenshot(task.id, name);
  if (!image) return c.text("Not found", 404);
  return c.body(new Uint8Array(image.bytes), 200, {
    "content-type": image.mime,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; sandbox",
  });
}

/** How often an open stream asks whether its request may still use the API, so signing out ends it. */
export const STREAM_RECHECK_MS = 30_000;

/** Live events for one task, or for the whole factory when id is "all". Ends once its request would be refused. */
function eventStream({ store, access }: RouteDeps, c: Context, id: string) {
  let cursor = Number(c.req.query("after") ?? (id === "all" ? store.latestEventId() : 0));
  return streamSSE(c, async (stream) => {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });
    let checkedAt = access.now();
    while (alive) {
      if (access.now() - checkedAt >= STREAM_RECHECK_MS) {
        if (!admit(access, c).ok) break;
        checkedAt = access.now();
      }
      const events = id === "all" ? store.eventsSince(cursor) : store.listEvents(id, cursor);
      for (const e of events) {
        await stream.writeSSE({ data: JSON.stringify(e), event: "event", id: String(e.id) });
        cursor = e.id;
      }
      await stream.sleep(events.length ? 50 : 500);
    }
  });
}

/** Listing, reading and creating tasks. `/tasks/queue` must come before `/tasks/:id`. */
export function registerTaskRoutes(api: Hono, deps: RouteDeps): void {
  const { store, actions } = deps;
  api.get("/tasks", (c) => {
    const status = c.req.query("status")?.split(",").filter(Boolean) as TaskStatus[] | undefined;
    const repoId = c.req.query("repo") || undefined;
    return c.json(store.listTaskSummaries({ status, repoId }));
  });
  api.get("/tasks/queue", (c) => c.json(store.listQueuedTaskSummaries()));
  api.post("/tasks/:id/agent", async (c) => {
    const { driver, model, effort } = await optionalJsonObject<TaskRunOptions>(c.req.raw);
    return c.json(actions.changeAgent(c.req.param("id"), { driver, model, effort }));
  });
  api.get("/tasks/:id", (c) => {
    const m = store.getTask(c.req.param("id"));
    if (!m) return c.json({ error: "Not found" }, 404);
    return c.json(taskDetail(store, m));
  });
  api.get("/tasks/:id/screenshots/:name", (c) => screenshot(store, c, c.req.param("id"), c.req.param("name")));
  api.get("/tasks/:id/diff", async (c) => {
    const m = store.getTask(c.req.param("id"));
    const repo = m?.repoId ? store.getRepo(m.repoId) : null;
    if (!m || !repo) return c.json({ diff: "", live: false } satisfies TaskDiff);
    const merged = m.status === "merged" ? lastMergeOutcome(store.listEvents(m.id))?.commit : null;
    return c.json(await diffForTask(repo, m, merged));
  });
  api.get("/tasks/:id/stream", (c) => eventStream(deps, c, c.req.param("id")));
  api.post("/instruct/draft", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    const draft: TaskDraft = draftTask(text ?? "", store.listRepos(), { lastRepoId: store.getSetting("last_repo") });
    return c.json(draft);
  });
  api.post("/tasks", async (c) => {
    const body = await c.req.json<NewTask>();
    return c.json(actions.createTask(body), 201);
  });
}
