import { AsyncLocalStorage } from "node:async_hooks";
import type { EventActor } from "@crane/contracts";

/**
 * Who is acting: the auth middleware sets the signed-in operator for each
 * request, and the CLI sets the host for each command. Anything that runs
 * inside `fn`, including after awaits, sees the same actor.
 */
const actors = new AsyncLocalStorage<EventActor>();

export function withActor<T>(actor: EventActor, fn: () => T): T {
  return actors.run(actor, fn);
}

export function currentActor(): EventActor | null {
  return actors.getStore() ?? null;
}
