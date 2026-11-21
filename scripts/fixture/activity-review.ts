import type { Store } from "@crane/storage";

const REVIEW_PATH = "/_fixture/activity-review";
const LONG_HISTORY = 180;

function seedActivityTask(store: Store, title: string, brief: string, count: number) {
  const task = store.createTask({ kind: "factory_feature", title, brief, repoId: null, autonomy: "observe" });
  for (let i = 1; i <= count; i++) {
    store.addEvent(task.id, "note", `${title} entry ${String(i).padStart(3, "0")}`);
  }
  return task.id;
}

/** Used only by the disposable screenshot server, which has no worker advancing either task. */
export function createActivityReview(store: Store) {
  const { primary, secondary } = store.transaction(() => {
    const brief = Array.from({ length: 45 }, (_, i) => (
      `Instruction ${i + 1}. Check the activity timeline against the candidate build and record the result.`
    )).join("\n\n");
    const primary = seedActivityTask(store, "Long activity history", brief, LONG_HISTORY);
    store.updateTask(primary, { status: "running" });
    const secondary = seedActivityTask(store, "Second activity history", "Check that switching tasks resets the timeline.", 24);
    return { primary, secondary };
  });
  let appended = 0;
  return (request: Request): Response | null => {
    if (new URL(request.url).pathname !== REVIEW_PATH) return null;
    if (request.method === "GET") return Response.json({ primary, secondary });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    // A cross-origin page can't set this header without a successful preflight.
    if (request.headers.get("X-Crane-Activity-Review") !== "append") return new Response(null, { status: 403 });
    const event = store.addEvent(primary, "note", `Live review entry ${appended + 1}`);
    appended++;
    return Response.json(event);
  };
}
