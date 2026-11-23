import { actorSnapshot } from "@crane/backend-runtime";
import type { EventActor, RunnerSummary } from "@crane/contracts";
import type { RunnerRecord, Store } from "@crane/storage";
import { checkRunnerCapacity, checkRunnerId, checkRunnerName, checkRunnersRequired } from "../action-inputs.js";
import { newToken, tokenDigest } from "../auth-crypto.js";
import { defaultRunnerKey, RUNNERS_REQUIRED_KEY, type RunnersRequired } from "../settings.js";
import { AccessError } from "./access-errors.js";
import { checkUsername, iso, requireAdmin, requireHost, type AccessDeps } from "./access-rules.js";

export type NewRunnerInput = {
  name: unknown;
  capacity?: unknown;
  /** The owner's username when registering a container from the host. */
  operator?: unknown;
};

/** The raw token is available only in the response to registration or rotation. */
export type IssuedRunner = { runner: RunnerSummary; token: string };
export type RunnerUpdate = { name?: unknown; capacity?: unknown };

const ADD_CONTAINER = "Add a container from Account → Containers, then try again";

function ownerForRegistration(store: Store, by: EventActor, username: unknown): string {
  if (by.kind === "operator" && username === undefined) {
    if (!store.access.operatorById(by.id)) throw new AccessError(403, "Sign in to add a container");
    return by.id;
  }
  requireHost(by);
  const operator = store.access.operatorByUsername(checkUsername(username));
  if (!operator) throw new Error("Choose an existing operator to own this container");
  return operator.id;
}

function liveRunner(store: Store, id: string): RunnerRecord {
  const runner = store.runners.byId(id);
  if (!runner || runner.revokedAt) throw new Error("Choose a registered container");
  return runner;
}

export function addRunner({ store, now }: AccessDeps, by: EventActor, input: NewRunnerInput): IssuedRunner {
  return store.transaction(() => {
    const operatorId = ownerForRegistration(store, by, input?.operator);
    const name = checkRunnerName(input?.name);
    const capacity = input?.capacity === undefined ? 1 : checkRunnerCapacity(input.capacity);
    const at = now();
    const token = newToken();
    const { id } = store.runners.create({ operatorId, name, capacity, tokenHash: tokenDigest(token), at: iso(at) });
    store.runners.recordOperatorEvent(id, by, "Added container", iso(at));
    return { runner: store.runners.summary(id, at)!, token };
  }, { immediate: true });
}

export function listRunners({ store, now }: AccessDeps, by: EventActor): RunnerSummary[] {
  if (by.kind === "operator" && store.access.operatorById(by.id)?.role !== "admin") {
    return store.runners.listFor(by.id, now());
  }
  requireAdmin(store, by);
  return store.runners.listAll(now());
}

/** Authorize and record the change under the same lock as rotation and removal. */
function manageRunner<T>(deps: AccessDeps, by: EventActor, id: string, change: (runner: RunnerRecord, at: number) => T): T {
  const { store } = deps;
  return store.transaction(() => {
    const runner = liveRunner(store, id);
    if (by.kind !== "operator" || by.id !== runner.operatorId) {
      requireAdmin(store, by, "Only the container's owner or an admin can manage it");
    }
    return change(runner, deps.now());
  }, { immediate: true });
}

export function renameRunner(deps: AccessDeps, by: EventActor, id: string, input: unknown): RunnerSummary {
  return updateRunner(deps, by, id, { name: input });
}

export function setRunnerCapacity(deps: AccessDeps, by: EventActor, id: string, input: unknown): RunnerSummary {
  return updateRunner(deps, by, id, { capacity: input });
}

export function updateRunner({ store, now }: AccessDeps, by: EventActor, id: string, patch: RunnerUpdate): RunnerSummary {
  return manageRunner({ store, now }, by, id, (runner, at) => {
    if (!Object.hasOwn(patch, "name") && !Object.hasOwn(patch, "capacity")) throw new Error("Give a name or capacity to change");
    if (Object.hasOwn(patch, "name")) {
      const name = checkRunnerName(patch.name);
      store.runners.rename(id, name);
      store.runners.recordOperatorEvent(id, by, `Renamed container from ${runner.name} to ${name}`, iso(at));
    }
    if (Object.hasOwn(patch, "capacity")) {
      const capacity = checkRunnerCapacity(patch.capacity);
      store.runners.setCapacity(id, capacity);
      store.runners.recordOperatorEvent(id, by, `Set container capacity to ${capacity}`, iso(at));
    }
    return store.runners.summary(id, at)!;
  });
}

export function rotateRunnerToken(deps: AccessDeps, by: EventActor, id: string): IssuedRunner {
  return manageRunner(deps, by, id, (_runner, at) => {
    const token = newToken();
    deps.store.runners.rotateToken(id, tokenDigest(token));
    deps.store.runners.recordOperatorEvent(id, by, "Rotated container token", iso(at));
    return { runner: deps.store.runners.summary(id, at)!, token };
  });
}

export function removeRunner(deps: AccessDeps, by: EventActor, id: string): void {
  const { store } = deps;
  manageRunner(deps, by, id, (runner, at) => {
    store.runners.revoke(id, iso(at));
    const key = defaultRunnerKey(runner.operatorId);
    if (store.getSetting(key) === id) store.setSetting(key, "");
    for (const taskId of store.runners.runningTaskIds(id)) {
      store.closeUnresolvedCommands(taskId);
      store.updateTask(taskId, { agentId: null });
      store.setStatus(taskId, "queued", "Back in the queue");
      store.addEvent(taskId, "note", "The container was removed. Choose another container before this task can run", { runnerId: id });
    }
    store.runners.recordOperatorEvent(id, by, "Removed container", iso(at));
  });
}

export function authenticateRunner({ store, now }: AccessDeps, token: unknown): RunnerRecord | null {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const digest = tokenDigest(token);
  return store.transaction(() => {
    const runner = store.runners.byTokenHash(digest);
    if (!runner) return null;
    const lastSeenAt = iso(now());
    store.runners.touch(runner.id, lastSeenAt);
    return { ...runner, lastSeenAt };
  }, { immediate: true });
}

export function requireRunnerOwner(runner: RunnerRecord, by: EventActor | null): void {
  if (by?.kind !== "operator" || by.id !== runner.operatorId) {
    throw new AccessError(403, "Only the container's owner can route work to it");
  }
}

export function runnersRequired(store: Store, by?: EventActor): RunnersRequired {
  if (by) requireAdmin(store, by, "Only admins can read whether containers are required");
  return store.getSetting(RUNNERS_REQUIRED_KEY) === "on" ? "on" : "off";
}

export function setRunnersRequired({ store, now }: AccessDeps, by: EventActor, input: unknown): RunnersRequired {
  return store.transaction(() => {
    requireAdmin(store, by, "Only admins can change whether containers are required");
    const value = checkRunnersRequired(input);
    store.setSetting(RUNNERS_REQUIRED_KEY, value);
    store.runners.recordOperatorEvent(null, by, value === "on" ? "Required containers" : "Made containers optional", iso(now()));
    return value;
  }, { immediate: true });
}

export function defaultRunner(store: Store, by: EventActor | null): string | null {
  if (by?.kind !== "operator") return null;
  const id = store.getSetting(defaultRunnerKey(by.id));
  const runner = id ? store.runners.byId(id) : null;
  return runner?.operatorId === by.id && !runner.revokedAt ? runner.id : null;
}

export function setDefaultRunner({ store, now }: AccessDeps, by: EventActor, input: unknown): string | null {
  return store.transaction(() => {
    if (by.kind !== "operator" || !store.access.operatorById(by.id)) {
      throw new AccessError(403, "Sign in to choose your default container");
    }
    const id = checkRunnerId(input);
    if (id) requireRunnerOwner(liveRunner(store, id), by);
    const previous = defaultRunner(store, by);
    store.setSetting(defaultRunnerKey(by.id), id ?? "");
    store.runners.recordOperatorEvent(id ?? previous, by, id ? "Set default container" : "Cleared default container", iso(now()));
    return id;
  }, { immediate: true });
}

function checkRunnerRequired(store: Store, id: string | null, by: EventActor | null): void {
  if (!id && by?.kind !== "host" && runnersRequired(store) === "on") throw new AccessError(403, ADD_CONTAINER);
}

export function resolveTaskRunner(store: Store, input?: string | null, by = actorSnapshot()): string | null {
  const id = input === undefined ? defaultRunner(store, by) : checkRunnerId(input);
  if (id && input !== undefined) requireRunnerOwner(liveRunner(store, id), by);
  checkRunnerRequired(store, id, by);
  return id;
}

/** Existing routes are protected from edits by other operators. The host can clear an existing route. */
export function requireExistingRunnerOwner(store: Store, id: string | null, by = actorSnapshot()): void {
  const runner = id ? store.runners.byId(id) : null;
  if (runner && by?.kind !== "host") requireRunnerOwner(runner, by);
}

export function checkInheritedRunner(store: Store, id: string | null): void {
  const by = actorSnapshot();
  if (id && by?.kind !== "host") requireRunnerOwner(liveRunner(store, id), by);
  checkRunnerRequired(store, id, by);
}
