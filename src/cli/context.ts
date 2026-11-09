import { createInterface } from "node:readline";
import type { EventActor } from "@crane/contracts";
import { hostActor } from "@crane/backend-runtime";
import type { Store } from "../core/store.js";
import { OperatorActions } from "../factory/actions.js";

/** Where a command reads what the operator types. Tests replace it to feed `--password-stdin`. */
export interface CliIo {
  /** The first line of standard input, without its line ending, or "" when there is none. */
  readLine(): Promise<string>;
}

/** What every command runs against. `runCli` builds one per call, so tests can hand the CLI their own store. */
export interface CliContext {
  readonly store: Store;
  readonly actions: OperatorActions;
  /** Whoever runs crane on this machine. The host counts as an admin, and CLI actions are attributed to it. */
  readonly host: EventActor;
  readonly io: CliIo;
}

export function createCliContext(store: Store, io: Partial<CliIo> = {}): CliContext {
  return { store, actions: new OperatorActions(store), host: hostActor(), io: { readLine: io.readLine ?? readStdinLine } };
}

/** The host's login name, or "host" when the system can't say. One definition, shared with `runCli`. */
export { hostActor };

function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, terminal: false });
    let first: string | null = null;
    lines.once("line", (line) => {
      first = line;
      lines.close();
    });
    lines.once("close", () => resolve((first ?? "").replace(/\r$/, "")));
  });
}
