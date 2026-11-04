import type { useAction } from "../../lib/action";

/** The page's action runner, handed to every part that can act on the task. */
export interface TaskActions {
  busy: boolean;
  run: ReturnType<typeof useAction>["run"];
}
