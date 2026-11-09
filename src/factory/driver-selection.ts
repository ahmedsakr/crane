import { driverLabel, type Task } from "@crane/contracts";
import type { AgentDriver } from "@crane/agent-protocol";
import type { Store } from "@crane/storage";
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
 * else the crew member's preference, then the factory's default.
 */
export function driverFor(store: Store, drivers: DriverRegistry, task: Task, agentId: string): AgentDriver {
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
