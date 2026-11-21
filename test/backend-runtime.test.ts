import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { EventActor } from "@crane/contracts";
import { actorSnapshot, withActor } from "@crane/backend-runtime";

const HOST: EventActor = { kind: "host", name: "ahmed" };

test("actor: actorSnapshot follows withActor across awaits and is null outside", async () => {
  assert.equal(actorSnapshot(), null);
  const sam: EventActor = { kind: "operator", id: "o-sam", name: "Sam" };
  assert.equal(withActor(HOST, () => actorSnapshot()?.name), "ahmed");
  const seen = await withActor(sam, async () => {
    const before = actorSnapshot();
    await sleep(5);
    const inner = await withActor(HOST, async () => { await sleep(1); return actorSnapshot(); });
    await Promise.resolve();
    return [before, inner, actorSnapshot()];
  });
  assert.deepEqual(seen, [sam, HOST, sam]);
  // Two requests at once each keep their own actor.
  const both = await Promise.all([sam, HOST].map((actor) => withActor(actor, async () => { await sleep(3); return actorSnapshot(); })));
  assert.deepEqual(both, [sam, HOST]);
  assert.equal(actorSnapshot(), null);
});
