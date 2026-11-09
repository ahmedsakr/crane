/**
 * The fixture's dashboard: the real API and UI with no factory behind them, so
 * nothing claims, runs or finishes a task while it's being captured. A heartbeat
 * at the stopped clock reads as a factory that's always running.
 *
 *   node <FIXTURE_NODE_ARGS> scripts/fixture/serve.ts <port>
 */
import { serve } from "@hono/node-server";
import { craneHome } from "@crane/backend-runtime";
import { Store } from "@crane/storage";
import { DEFAULT_DRIVER_KEY, HEARTBEAT_KEY } from "../../src/factory/settings.js";
import { createApp } from "../../src/server/app.js";

/** Kept here rather than read from the factory, so a change to its crew doesn't move fixture pixels. */
const CREW = [
  { id: "a-jib", name: "Jib", active: true },
  { id: "a-boom", name: "Boom", active: true },
  { id: "a-hoist", name: "Hoist", active: true },
  { id: "a-trolley", name: "Trolley", active: false },
];

/**
 * The crew a factory would clock in. Like a starting factory, it puts seeded running tasks back in
 * the queue; then Jib holds the first queued task and everything else stays queued.
 */
function holdFactoryState(store: Store) {
  store.setSetting(HEARTBEAT_KEY, String(Date.now()));
  for (const task of store.listTasks({ status: ["running"] })) store.updateTask(task.id, { status: "queued", agentId: null });
  store.setSetting(DEFAULT_DRIVER_KEY, "simulated");
  for (const { id, name, active } of CREW) {
    store.upsertAgent({ id, name, driver: "simulated" });
    store.setSetting(`crew_active_${id}`, String(active));
    store.setAgentState(id, "idle", null);
  }
  const held = store.claimNextTask("a-jib");
  if (held) store.setAgentState("a-jib", "working", held.id);
}

/** Temp homes and checkouts differ between captures, so responses show the same two paths every time. */
function stablePaths(store: Store): (body: string) => string {
  const factory = store.listRepos().find((r) => r.isFactory)?.path;
  return (body) => {
    const fixed = body.replaceAll(craneHome(), "/fixture/home");
    return factory ? fixed.replaceAll(factory, "/fixture/crane") : fixed;
  };
}

const port = Number(process.argv[2]);
if (!port) throw new Error("Pass the port to listen on");
const store = new Store();
holdFactoryState(store);
const app = createApp(store);
const rewrite = stablePaths(store);

serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    const response = await app.fetch(request);
    if (!response.headers.get("content-type")?.startsWith("application/json")) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(rewrite(await response.text()), { status: response.status, headers });
  },
});
