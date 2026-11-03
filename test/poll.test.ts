import { test } from "node:test";
import assert from "node:assert/strict";
import { createPollRequest } from "../web/src/lib/poll.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const state: { data: string[] | null; error: string | null } = { data: null, error: null };
  const request = createPollRequest<string[]>(
    data => { state.data = data; },
    error => { state.error = error; },
  );
  return { state, request };
}

test("poll: an old filter response cannot overwrite the selected filter", async () => {
  const { state, request } = setup();
  const oldFilter = deferred<string[]>();
  const oldRefresh = request.refresh(() => oldFilter.promise);
  request.invalidate(); // usePoll's dependency cleanup
  await request.refresh(async () => ["needs review"]);
  oldFilter.resolve(["queued"]);
  await oldRefresh;
  assert.deepEqual(state, { data: ["needs review"], error: null });
});

test("poll: cleanup ignores a response even before the next request starts", async () => {
  const { state, request } = setup();
  const pending = deferred<string[]>();
  const refresh = request.refresh(() => pending.promise);
  request.invalidate(); // dependency change or unmount
  pending.resolve(["old filter"]);
  await refresh;
  assert.deepEqual(state, { data: null, error: null });
});

test("poll: a stale failure cannot replace a current success", async () => {
  const { state, request } = setup();
  const pending = deferred<string[]>();
  const refresh = request.refresh(() => pending.promise);
  request.invalidate();
  await request.refresh(async () => ["current"]);
  pending.reject(new Error("old failure"));
  await refresh;
  assert.deepEqual(state, { data: ["current"], error: null });
});

test("poll: overlapping refreshes keep the latest error until a new success", async () => {
  const { state, request } = setup();
  const pending = deferred<string[]>();
  const refresh = request.refresh(() => pending.promise);
  await request.refresh(async () => { throw new Error("current failure"); });
  pending.resolve(["older success"]);
  await refresh;
  assert.deepEqual(state, { data: null, error: "current failure" });
  await request.refresh(async () => ["recovered"]);
  assert.deepEqual(state, { data: ["recovered"], error: null });
});
