import * as p from "@clack/prompts";
import type { EventActor } from "@crane/contracts";
import type { CliContext } from "../context.js";

export const AS_OPERATOR_HELP = "act as this operator, using their password (read from stdin without a terminal)";

/** The local CLI defaults to the host. A named operator must prove their identity. */
export async function cliActor(ctx: CliContext, username?: string): Promise<EventActor> {
  if (username === undefined) return ctx.host;
  const password = process.stdin.isTTY ? await p.password({ message: `Password for ${username}` }) : await ctx.io.readLine();
  if (p.isCancel(password)) throw new Error("Cancelled");
  const { operator, token } = await ctx.actions.signIn(username, password, { client: "Crane CLI" });
  ctx.actions.signOut(token);
  return { kind: "operator", id: operator.id, name: operator.name };
}
