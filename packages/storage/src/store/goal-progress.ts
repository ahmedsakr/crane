import { goalProgress, type GoalListItem, type TaskStatus } from "@crane/contracts";
import type { Store } from "../store.js";

type GoalListSource = Pick<Store, "db" | "listGoalSummaries">;

/**
 * The Goals page's rows, with each goal's progress read in one query. Home's
 * polled overview uses plain summaries and doesn't pay for this.
 */
export function goalListItems(store: GoalListSource): GoalListItem[] {
  const planned = store.db.prepare("SELECT id, json_array_length(data, '$.plan.tasks') AS tasks FROM goals").all() as { id: string; tasks: number | null }[];
  const linked = store.db.prepare(`SELECT g.id AS goalId, t.status AS status, t.branch AS branch
    FROM goals g, json_each(g.data, '$.tasks') AS link
    JOIN tasks t ON t.id = json_extract(link.value, '$.taskId')`).all() as { goalId: string; status: TaskStatus; branch: string | null }[];
  const plannedBy = new Map(planned.map((row) => [row.id, row.tasks ?? 0]));
  return store.listGoalSummaries().map((goal) => ({ ...goal,
    plannedTasks: plannedBy.get(goal.id) ?? 0,
    progress: goalProgress(linked.filter((task) => task.goalId === goal.id)) }));
}
