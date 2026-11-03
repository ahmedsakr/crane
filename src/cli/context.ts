import type { Store } from "../core/store.js";
import { OperatorActions } from "../factory/actions.js";

/** What every command runs against. `runCli` builds one per call, so tests can hand the CLI their own store. */
export interface CliContext {
  readonly store: Store;
  readonly actions: OperatorActions;
}

export function createCliContext(store: Store): CliContext {
  return { store, actions: new OperatorActions(store) };
}
