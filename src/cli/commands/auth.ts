import type { Command } from "commander";
import pc from "picocolors";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { attempt, confirmed, findOperator, plural } from "./access-shared.js";

/**
 * `crane auth`: whether the dashboard asks anyone to sign in, and which devices
 * are signed in. `crane auth off` is host-only: turning sign-in off from a
 * browser would expose the dashboard to whoever reaches it.
 */

const EXPOSED_WARNING = "A factory served on a public address now refuses every API call until you add an operator again.";

export function registerAuth(program: Command, ctx: CliContext): void {
  const auth = program.command("auth").description("Dashboard sign-in: status, signed-in devices, and turning it off");
  auth.action(() => authStatus(ctx));
  auth.command("status").description("Whether sign-in is set up, who can sign in, and how many devices are signed in")
    .action(() => authStatus(ctx));
  auth.command("devices").description("List every signed-in device")
    .option("--operator <username>", "only this operator's devices")
    .option("--json", "print the devices as JSON")
    .action((opts: { operator?: string; json?: boolean }) => attempt(() => listDevices(ctx, opts)));
  auth.command("sign-out").description("Sign out one device by its id, or every device with --all")
    .argument("[sessionId]")
    .option("--all", "sign out every device of every operator")
    .action((id: string | undefined, opts: { all?: boolean }) => attempt(() => signOut(ctx, id, opts)));
  auth.command("off").description("Turn sign-in off: remove every operator, invite and signed-in device")
    .option("--yes", "don't ask to confirm")
    .action((opts: { yes?: boolean }) => attempt(() => turnOff(ctx, opts)));
}

function authStatus({ actions, host }: CliContext): void {
  const operators = actions.listOperators();
  const admins = operators.filter((o) => o.role === "admin").length;
  const devices = actions.listAllSessions(host).length;
  console.log(`\n${ui.brand()}  ${ui.dim("sign-in")}\n`);
  if (!operators.length) {
    console.log(`  ${pc.dim("○")} Sign-in isn't set up  ${ui.dim("no operators yet")}`);
    console.log(ui.dim("  On this machine the dashboard needs no sign-in. Served on a public address, it refuses every API call."));
    console.log(`\n${ui.hint(["crane operators add <username> --admin", "add the first admin"])}\n`);
    return;
  }
  console.log(`  ${pc.green("●")} Sign-in is set up  ${ui.dim("every API call needs a signed-in operator")}`);
  console.log(`    ${plural(operators.length, "operator")} · ${plural(admins, "admin")} · ${plural(devices, "device")} signed in`);
  console.log(`\n${ui.hint(
    ["crane operators", "see who can sign in"],
    ["crane operators invite", "invite someone with a single-use link"],
    ["crane auth devices", "see signed-in devices"],
  )}\n`);
}

function listDevices(ctx: CliContext, opts: { operator?: string; json?: boolean }): void {
  const only = opts.operator ? findOperator(ctx, opts.operator).id : null;
  const sessions = ctx.actions.listAllSessions(ctx.host).filter((s) => !only || s.operatorId === only);
  if (opts.json) {
    const rows = sessions.map(({ id, username, operatorName, client, createdAt, lastSeenAt, expiresAt }) =>
      ({ id, operator: username, operatorName, client, createdAt, lastSeenAt, expiresAt }));
    return void console.log(JSON.stringify(rows, null, 2));
  }
  console.log(ui.section("Signed-in devices", sessions.length));
  for (const s of sessions) {
    const when = `signed in ${ui.ago(s.createdAt)} · last seen ${ui.ago(s.lastSeenAt)}`;
    console.log(`  ${ui.dim(s.id)}  ${pc.bold(s.username.padEnd(16))} ${(s.client ?? "Unknown device").padEnd(22)} ${ui.dim(when)}`);
  }
  const first = sessions[0];
  console.log(`\n${ui.hint(
    [`crane auth sign-out ${first?.id ?? "<id>"}`, "sign out one device"],
    ["crane auth sign-out --all", "sign out every device"],
  )}\n`);
}

function signOut(ctx: CliContext, id: string | undefined, opts: { all?: boolean }): void {
  const { actions, host } = ctx;
  if (id && opts.all) ui.fail("Give a device id or --all, not both");
  if (!id && !opts.all) ui.fail("Give a device id from `crane auth devices`, or --all");
  if (id) {
    actions.signOutSessionById(host, id);
    return ui.ok(`Signed out ${ui.dim(id)}`);
  }
  const n = actions.listOperators().reduce((sum, o) => sum + actions.signOutOperator(host, o.id), 0);
  ui.ok(`Signed out ${plural(n, "device")}`);
}

async function turnOff(ctx: CliContext, opts: { yes?: boolean }): Promise<void> {
  const { actions, host } = ctx;
  const operators = actions.listOperators().length;
  const invites = actions.listInvites(host).length;
  const devices = actions.listAllSessions(host).length;
  const question = `Remove ${plural(operators, "operator")}, ${plural(invites, "pending link")} and ${plural(devices, "signed-in device")}? ${EXPOSED_WARNING}`;
  if (!(await confirmed(question, opts.yes))) return ui.fail("Kept sign-in on");
  actions.clearAccess(host);
  ui.ok(`Turned sign-in off ${ui.dim(`removed ${plural(operators, "operator")}, ${plural(invites, "pending link")} and ${plural(devices, "device")}`)}`);
  console.log(`  ${ui.accent("!")} ${EXPOSED_WARNING}`);
  console.log(`\n${ui.hint(["crane operators add <username> --admin", "turn sign-in on again"])}\n`);
}
