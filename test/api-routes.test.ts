import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { createApp } from "../src/server/app.js";

/** Every route the API answers. Paths and methods are the dashboard's and CLI's contract, so they mustn't drift. */
const ROUTES = [
  "DELETE /api/agents/:id/schedules/:scheduleId",
  "DELETE /api/auth/me/sessions/:id",
  "DELETE /api/operators/:id",
  "DELETE /api/operators/invites/:id",
  "DELETE /api/repos/:id",
  "DELETE /api/tasks/:id/pre-approve",
  "GET /*",
  "GET /api/agents",
  "GET /api/agents/:id/schedules",
  "GET /api/analytics",
  "GET /api/auth/me/sessions",
  "GET /api/auth/session",
  "GET /api/blocked",
  "GET /api/crew/schedules",
  "GET /api/drivers",
  "GET /api/factory/postmortem",
  "GET /api/factory/retention",
  "GET /api/goals",
  "GET /api/goals/:id",
  "GET /api/operators",
  "GET /api/operators/invites",
  "GET /api/overview",
  "GET /api/repos",
  "GET /api/repos/:id/checks",
  "GET /api/tasks",
  "GET /api/tasks/:id",
  "GET /api/tasks/:id/diff",
  "GET /api/tasks/:id/screenshots/:name",
  "GET /api/tasks/:id/stream",
  "GET /api/tasks/queue",
  "POST /api/agents/:id",
  "POST /api/agents/:id/run",
  "POST /api/agents/:id/schedules",
  "POST /api/agents/:id/schedules/:scheduleId",
  "POST /api/auth/invites/accept",
  "POST /api/auth/invites/check",
  "POST /api/auth/me/name",
  "POST /api/auth/me/password",
  "POST /api/auth/me/sessions/sign-out-others",
  "POST /api/auth/sign-in",
  "POST /api/auth/sign-out",
  "POST /api/drivers/:name",
  "POST /api/factory/driver",
  "POST /api/factory/pause",
  "POST /api/factory/postmortem",
  "POST /api/factory/resume",
  "POST /api/factory/retention",
  "POST /api/goals",
  "POST /api/goals/:id/approve",
  "POST /api/goals/:id/cancel",
  "POST /api/goals/:id/feedback",
  "POST /api/goals/:id/plan/tasks/:key/agent",
  "POST /api/goals/:id/tasks/:taskId/retry",
  "POST /api/instruct/draft",
  "POST /api/operators/:id/reset",
  "POST /api/operators/:id/role",
  "POST /api/operators/:id/sign-out",
  "POST /api/operators/invites",
  "POST /api/repos",
  "POST /api/repos/:id/tools/allow",
  "POST /api/repos/:id/tools/disallow",
  "POST /api/repos/:id/tools/keep-blocked",
  "POST /api/tasks",
  "POST /api/tasks/:id/agent",
  "POST /api/tasks/:id/approve",
  "POST /api/tasks/:id/cancel",
  "POST /api/tasks/:id/follow-up",
  "POST /api/tasks/:id/merge",
  "POST /api/tasks/:id/move",
  "POST /api/tasks/:id/pre-approve",
  "POST /api/tasks/:id/reject",
  "POST /api/tasks/:id/retry",
  "POST /api/tasks/:id/schedule",
  "POST /api/tasks/:id/visual-review",
  "POST /api/tasks/:id/waive-prerequisites",
  "PUT /api/goals/:id/plan",
  "PUT /api/repos/:id/checks",
  "PUT /api/repos/:id/tools/commands",
];

function routeTable(app: ReturnType<typeof createApp>) {
  return app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
}

test("api routes: paths and methods stay as they are", () => {
  const store = new Store(":memory:");
  try {
    const table = routeTable(createApp(store));
    assert.deepEqual([...table].sort(), ROUTES);
    // Hono tries routes in order: the queue must win over a task called "queue", and the web app catches only the rest.
    assert.ok(table.indexOf("GET /api/tasks/queue") < table.indexOf("GET /api/tasks/:id"));
    assert.equal(table.at(-1), "GET /*");
  } finally { store.close(); }
});

test("api routes: cross-origin and non-loopback requests are refused before any route", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const task = store.createTask({ kind: "maintenance", title: "Refused", brief: "", repoId: repo.id, autonomy: "propose" });
    store.updateTask(task.id, { status: "needs_review", branch: `crane/${task.id}` });
    const app = createApp(store);
    const snapshot = () => ({ tasks: store.listTasks(), events: store.eventsSince(0), repos: store.listRepos(), agents: store.listAgents() });
    const before = snapshot();
    // Real ids, so a route that ran would act on something instead of answering 404.
    const params: Record<string, string> = { id: task.id, taskId: task.id, name: "shot.png", key: "a", scheduleId: "s" };
    const paths = ROUTES.map((route) => {
      const [method, path] = route.split(" ") as [string, string];
      return [method, path === "/*" ? "/tasks" : path.replace(/:(\w+)/g, (_, p: string) => params[p] ?? p)] as const;
    });
    const forgeries: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
    for (const [method, path] of paths) {
      const rebound = await app.request(`http://evil.example:4471${path}`, { method });
      assert.equal(rebound.status, 403, `rebound: ${method} ${path}`);
      assert.deepEqual(await rebound.json(), { error: "This dashboard only answers on localhost" });
      if (method === "GET") continue;
      for (const headers of forgeries) {
        const forged = await app.request(`http://localhost${path}`, {
          method, headers: { "content-type": "text/plain", ...headers }, body: "{}",
        });
        assert.equal(forged.status, 403, `forged: ${method} ${path}`);
        assert.deepEqual(await forged.json(), { error: "Cross-origin requests can't change anything" });
      }
    }
    assert.deepEqual(snapshot(), before);
  } finally { store.close(); }
});
