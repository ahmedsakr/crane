import type { InviteSummary, OperatorSummary } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import {
  attempt,
  confirmed,
  expiresIn,
  findOperator,
  newPassword,
  plural,
  printGenerated,
  printLink,
  roleWords,
  type PasswordOptions,
} from "./access-shared.js";

/**
 * `crane operators`: who can sign in to the dashboard. The host runs these as
 * an admin. Adding an operator with a password and setting another's password
 * directly are host-only; the dashboard uses invite and reset links instead.
 */

type AddOptions = PasswordOptions & { name?: string; admin?: boolean };
type ResetOptions = PasswordOptions & { link?: boolean };

export function registerOperators(program: Command, ctx: CliContext): void {
  const operators = program.command("operators").description("Who can sign in to the dashboard: add, invite, reset and remove operators");
  operators.action(() => listOperators(ctx, {}));
  operators.command("list").description("List operators, their roles and signed-in devices")
    .option("--json", "print the operators as JSON")
    .action((opts: { json?: boolean }) => listOperators(ctx, opts));
  operators.command("add").description("Add an operator with a password, on the host. This is how the first admin is created")
    .argument("<username>")
    .option("--name <name>", "the name shown on their decisions (default: the username)")
    .option("--admin", "let them manage operators")
    .option("--password-stdin", "read the password from one line of standard input")
    .option("--generate", "make up a random password and print it once")
    .action((username: string, opts: AddOptions) => attempt(() => addOperator(ctx, username, opts)));
  registerInvites(operators, ctx);
  registerChanges(operators, ctx);
}

function registerInvites(operators: Command, ctx: CliContext): void {
  const { actions, host } = ctx;
  operators.command("invite").description("Make a single-use link that adds an operator (expires in 7 days)")
    .option("--admin", "the operator joins as an admin")
    .option("--name <name>", "suggest the name they'll be shown as")
    .action((opts: { admin?: boolean; name?: string }) => attempt(() => {
      const { invite, token } = actions.inviteOperator(host, { role: opts.admin ? "admin" : "operator", name: opts.name });
      printLink(`Invite link for ${roleWords(invite.role ?? "operator")}`, token, invite.expiresAt);
      console.log(`\n${ui.hint(["crane operators invites", "see links not used yet"], [`crane operators revoke-invite ${invite.id}`, "cancel this link"])}\n`);
    }));
  operators.command("invites").description("List invite and reset links not used yet")
    .option("--json", "print the links as JSON")
    .action((opts: { json?: boolean }) => attempt(() => {
      const list = actions.listInvites(host);
      if (opts.json) return void console.log(JSON.stringify(list, null, 2));
      console.log(ui.section("Pending links", list.length));
      for (const invite of list) console.log(inviteLine(invite));
      console.log(`\n${ui.hint(["crane operators invite", "invite someone"])}\n`);
    }));
  operators.command("revoke-invite").description("Cancel an invite or reset link before it's used")
    .argument("<id>")
    .action((id: string) => attempt(() => {
      actions.revokeInvite(host, id);
      ui.ok(`Revoked link ${ui.dim(id)}`);
    }));
}

function registerChanges(operators: Command, ctx: CliContext): void {
  const { actions, host } = ctx;
  operators.command("role").description("Make an operator an admin, or an admin an operator")
    .argument("<username>").argument("<role>", "admin | operator")
    .action((username: string, role: string) => attempt(() => {
      const changed = actions.setOperatorRole(host, findOperator(ctx, username).id, role);
      ui.ok(`${changed.username} is now ${roleWords(changed.role)}`);
    }));
  operators.command("reset-password").description("Make a 24-hour reset link, or set a password directly on the host")
    .argument("<username>")
    .option("--link", "print a reset link (the default)")
    .option("--password-stdin", "set the password from one line of standard input, and sign them out everywhere")
    .option("--generate", "set a random password, print it once, and sign them out everywhere")
    .action((username: string, opts: ResetOptions) => attempt(() => resetPassword(ctx, username, opts)));
  operators.command("sign-out").description("Sign an operator out on every device")
    .argument("<username>")
    .action((username: string) => attempt(() => {
      const operator = findOperator(ctx, username);
      const n = actions.signOutOperator(host, operator.id);
      ui.ok(`Signed out ${plural(n, "device")} ${ui.dim(`for ${operator.username}`)}`);
    }));
  operators.command("remove").description("Remove an operator and sign them out everywhere")
    .argument("<username>")
    .option("--yes", "don't ask to confirm")
    .action((username: string, opts: { yes?: boolean }) => attempt(async () => {
      const operator = findOperator(ctx, username);
      if (!(await confirmed(`Remove ${operator.username}? Their devices are signed out and their links stop working.`, opts.yes))) {
        return ui.fail("Kept them");
      }
      actions.removeOperator(host, operator.id);
      ui.ok(`Removed ${operator.username}`);
    }));
}

function listOperators({ actions }: CliContext, opts: { json?: boolean }): void {
  const list = actions.listOperators();
  if (opts.json) return void console.log(JSON.stringify(list, null, 2));
  console.log(ui.section("Operators", list.length));
  if (!list.length) {
    console.log(ui.dim("  None yet, so the dashboard needs no sign-in on this machine."));
    console.log(`\n${ui.hint(["crane operators add <username> --admin", "add the first admin"])}\n`);
    return;
  }
  for (const o of list) console.log(operatorLine(o));
  console.log(`\n${ui.hint(
    ["crane operators invite", "invite someone with a single-use link"],
    ["crane operators reset-password <username>", "make a reset link"],
    ["crane auth devices", "see every signed-in device"],
  )}\n`);
}

function operatorLine(o: OperatorSummary): string {
  const dot = o.devices ? pc.green("●") : pc.dim("○");
  const seen = o.lastSeenAt ? `last seen ${ui.ago(o.lastSeenAt)}` : "not signed in";
  const right = [seen, plural(o.devices, "device")].join(" · ");
  return `  ${dot} ${pc.bold(o.username.padEnd(16))} ${ui.truncate(o.name, 24).padEnd(24)} ${o.role.padEnd(9)} ${ui.dim(right)}`;
}

function inviteWhat(invite: InviteSummary): string {
  if (invite.kind === "reset") return `reset for ${invite.forOperator?.username ?? "a removed operator"}`;
  return `join as ${invite.role ?? "operator"}${invite.name ? ` (${invite.name})` : ""}`;
}

function inviteLine(invite: InviteSummary): string {
  const what = inviteWhat(invite);
  const by = invite.invitedBy ? `by ${invite.invitedBy} · ` : "";
  return `  ${ui.dim(invite.id)}  ${what.padEnd(32)} ${ui.dim(`${by}expires in ${expiresIn(invite.expiresAt)}`)}`;
}

async function addOperator(ctx: CliContext, username: string, opts: AddOptions): Promise<void> {
  const { password, generated } = await newPassword(ctx, opts);
  const role = opts.admin ? "admin" : "operator";
  const added = await ctx.actions.addOperator(ctx.host, { username, name: opts.name ?? username, role, password });
  ui.ok(`Added ${added.username} as ${roleWords(added.role)}`);
  if (generated) printGenerated(added.username, password);
  console.log(`\n${ui.hint(
    ["crane operators invite", "invite someone else"],
    ["crane auth status", "see who can sign in"],
  )}\n`);
}

async function resetPassword(ctx: CliContext, username: string, opts: ResetOptions): Promise<void> {
  const direct = opts.passwordStdin || opts.generate;
  if (opts.link && direct) ui.fail("Choose --link, --password-stdin or --generate");
  const operator = findOperator(ctx, username);
  if (!direct) {
    const { invite, token } = ctx.actions.createPasswordReset(ctx.host, operator.id);
    printLink(`Reset link for ${operator.username}`, token, invite.expiresAt);
    console.log(ui.dim("  Any earlier reset link for them stops working."));
    return;
  }
  const { password, generated } = await newPassword(ctx, opts);
  await ctx.actions.setOperatorPassword(ctx.host, operator.id, password);
  ui.ok(`Set ${operator.username}'s password and signed them out everywhere`);
  if (generated) printGenerated(operator.username, password);
}
