import { driverLabel, isDriverName, runnerLabel, type DriverName, type Task } from "@crane/contracts";
import type { AgentDriver } from "@crane/agent-protocol";
import type { RunnerRecord, Store } from "@crane/storage";
import { REMOVED, RemoteDriver, type RemoteDriverOptions } from "./remote/driver.js";
import { waitingReturn } from "./runner-lane.js";
import { DEFAULT_DRIVER_KEY } from "./settings.js";

/** Every agent a factory can run, by name. The first is the default until the operator picks one. */
export type DriverRegistry = ReadonlyMap<string, AgentDriver>;

/** The operator's default agent, when this factory can run it; otherwise its first driver. */
export function defaultDriver(store: Store, drivers: DriverRegistry): AgentDriver {
  return drivers.get(store.getSetting(DEFAULT_DRIVER_KEY) ?? "") ?? drivers.values().next().value!;
}

/**
 * Who works a task: the agent the operator chose for it, else the one that
 * worked it last (it owns the task's session and knows the work so far),
 * else the crew member's preference, then the factory's default. A task
 * routed to a container runs there, for its work and its merge runs alike.
 */
export function driverFor(store: Store, drivers: DriverRegistry, task: Task, agentId: string, remote?: RemoteDriverOptions): AgentDriver {
  if (task.runnerId) return remoteDriverFor(store, task, task.runnerId, remote);
  if (task.driver) {
    const chosen = drivers.get(task.driver);
    if (!chosen) throw new Error(`This task asks for ${driverLabel(task.driver)}, which this factory can't run`);
    return chosen;
  }
  const previous = drivers.get(store.lastWorkDriver(task.id) ?? "");
  if (previous) return previous;
  const preferred = store.crewDefaultDriver(agentId);
  if (preferred) {
    const driver = drivers.get(preferred);
    if (!driver) throw new Error(`This crew member asks for ${driverLabel(preferred)}, which this factory can't run`);
    return driver;
  }
  return defaultDriver(store, drivers);
}

/** The task's container, running the agent the operator chose, else the one that holds its session there, else its first. */
function remoteDriverFor(store: Store, task: Task, runnerId: string, opts?: RemoteDriverOptions): RemoteDriver {
  const runner = store.runners.byId(runnerId);
  if (!runner || runner.revokedAt) throw new Error(REMOVED);
  return new RemoteDriver(store, runner.id, innerDriver(store, task, runner), opts);
}

function innerDriver(store: Store, task: Task, runner: RunnerRecord): DriverName {
  if (task.driver) {
    if (!isDriverName(task.driver)) throw new Error(`This task asks for ${task.driver}, which containers can't run`);
    return task.driver;
  }
  // Work the container returned while the factory was down is applied by the agent it was sent for.
  const returned = waitingReturn(store, task.id);
  const sent = (returned?.payload as { driver?: unknown } | null)?.driver;
  if (returned?.runnerId === runner.id && isDriverName(sent)) return sent;
  const previous = store.lastWorkDriver(task.id);
  if (isDriverName(previous) && store.lastWorkRunner(task.id) === runner.id && runner.drivers.includes(previous)) return previous;
  const first = runner.drivers[0];
  if (first) return first;
  const owner = store.access.operatorById(runner.operatorId)?.name ?? "An operator";
  throw new Error(`${runnerLabel({ name: runner.name, ownerName: owner })} hasn't said which agents are signed in on it. Start it with crane runner start, then retry`);
}
