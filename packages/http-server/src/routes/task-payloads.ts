import type { Overview } from "@crane/contracts";
import type { OperatorActions } from "@crane/factory/actions";

/** Reuse one lookup per container across a page of tasks, including assignments to removed containers. */
export function taskPayloads(actions: OperatorActions, lanes: Overview["runners"] = []) {
  const routes = new Map(lanes.map((lane) => [lane.id, { runnerLabel: lane.label, runnerOnline: lane.online }]));
  return <T extends { runnerId: string | null }>(task: T): T => {
    const id = task.runnerId;
    if (!id) return task;
    let route = routes.get(id);
    if (!route) {
      route = actions.runnerStatus(id) ?? { runnerLabel: "Unavailable container", runnerOnline: false };
      routes.set(id, route);
    }
    return { ...task, ...route };
  };
}
