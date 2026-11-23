import type { Context, Hono } from "hono";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { RUNNER_LIMITS } from "@crane/contracts";
import type { OperatorActions, OutgoingBundle } from "@crane/factory/actions";
import { BodyTooLarge, boundedBody, boundedJsonObject, parseJsonObject } from "../body.js";
import type { RouteDeps } from "./deps.js";

function downloadBundle(c: Context, bundle: OutgoingBundle): Response {
  const headers = {
    "content-type": "application/x-git-bundle",
    "content-length": String(bundle.bytes),
    "x-crane-bundle-refs": JSON.stringify(bundle.refs),
  };
  if (c.req.method === "HEAD") {
    bundle.remove();
    return c.body(null, 200, headers);
  }
  const file = createReadStream(bundle.path);
  file.once("close", () => {
    try {
      bundle.remove();
    } catch (err) {
      console.error("Could not remove an outgoing runner bundle", err);
    }
  });
  const body = Readable.toWeb(file, {
    strategy: { highWaterMark: file.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
  });
  return c.body(body as ReadableStream<Uint8Array>, 200, headers);
}

async function readResult(request: Request): Promise<{ result: object; bundle?: Uint8Array }> {
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return { result: await boundedJsonObject(request, RUNNER_LIMITS.resultBytes) };
  }
  const body = boundedBody(request, RUNNER_LIMITS.bundleBytes);
  const form = await body.formData().catch((err: unknown) => {
    if (err instanceof BodyTooLarge) throw err;
    throw new Error("Expected a multipart result and bundle");
  });
  const [json] = form.getAll("result");
  const [file] = form.getAll("bundle");
  if (typeof json !== "string" || !file || typeof file === "string" || [...form].length !== 2) {
    throw new Error("Send one JSON result field and one bundle file");
  }
  if (Buffer.byteLength(json) > RUNNER_LIMITS.resultBytes) throw new BodyTooLarge();
  const result = parseJsonObject(json);
  return { result, bundle: new Uint8Array(await file.arrayBuffer()) };
}

/** Reject inaccessible jobs before reading their bodies. The mutation checks the job again before applying them. */
function requireJob(actions: OperatorActions, c: Context, id: string) {
  const runner = c.get("runner");
  actions.requireRunnerJob(runner, id);
  return runner;
}

/** Container-only routes. The bearer gate runs before they check job ownership or consume a body. */
export function registerRunnerRoutes(api: Hono, { actions }: RouteDeps): void {
  api.post("/runner/heartbeat", async (c) => {
    const body = await boundedJsonObject(c.req.raw, RUNNER_LIMITS.controlBytes);
    return c.json(actions.runnerHeartbeat(c.get("runner"), body));
  });
  api.post("/runner/jobs/claim", async (c) => {
    await boundedJsonObject(c.req.raw, RUNNER_LIMITS.controlBytes);
    return c.json(actions.claimRunnerJob(c.get("runner")));
  });
  // Each have query parameter is a commit the container already has. A 204 means it needs no bundle.
  api.get("/runner/jobs/:id/bundle", async (c) => {
    const bundle = await actions.jobBundle(c.get("runner"), c.req.param("id"), c.req.queries("have"));
    return bundle ? downloadBundle(c, bundle) : c.body(null, 204);
  });
  api.post("/runner/jobs/:id/events", async (c) => {
    const id = c.req.param("id");
    const runner = requireJob(actions, c, id);
    const batch = await boundedJsonObject(c.req.raw, RUNNER_LIMITS.eventBatchBytes);
    return c.json(actions.appendJobEvents(runner, id, batch));
  });
  api.post("/runner/jobs/:id/session", async (c) => {
    const id = c.req.param("id");
    const runner = requireJob(actions, c, id);
    const { sessionId } = await boundedJsonObject<{ sessionId?: unknown }>(c.req.raw, RUNNER_LIMITS.controlBytes);
    actions.recordJobSession(runner, id, sessionId);
    return c.body(null, 204);
  });
  api.put("/runner/jobs/:id/screenshots/:name", async (c) => {
    const id = c.req.param("id");
    const runner = requireJob(actions, c, id);
    const bytes = new Uint8Array(await boundedBody(c.req.raw, RUNNER_LIMITS.screenshotBytes).arrayBuffer());
    return c.json(actions.storeJobScreenshot(runner, id, c.req.param("name"), bytes));
  });
  // JSON for a result alone, or multipart with a JSON text field (result) and one file (bundle).
  api.post("/runner/jobs/:id/result", async (c) => {
    const id = c.req.param("id");
    const runner = requireJob(actions, c, id);
    const { result, bundle } = await readResult(c.req.raw);
    actions.returnJob(runner, id, result, bundle);
    return c.body(null, 204);
  });
  api.all("/runner/*", (c) => c.json({ error: "Not found" }, 404));
}
