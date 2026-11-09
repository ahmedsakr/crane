import { AsyncLocalStorage } from "node:async_hooks";
import { userInfo } from "node:os";
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

/**
 * The current actor as it is right now, for storing with history: only the
 * kind, id and name, so a later rename or removal doesn't change the record.
 */
export function actorSnapshot(): EventActor | null {
  const actor = currentActor();
  if (!actor) return null;
  return actor.kind === "operator" ? { kind: "operator", id: actor.id, name: actor.name } : { kind: "host", name: actor.name };
}

/** Someone running crane on this machine, named by their system account. */
export function hostActor(): EventActor {
  let name = process.env.USER || process.env.USERNAME || "";
  try {
    name = userInfo().username || name;
  } catch {
    // Some containers have no passwd entry for the current uid.
  }
  return { kind: "host", name: name || "host" };
}
