import * as p from "@clack/prompts";
import { errorMessage, normalizeUsername, type OperatorRole, type OperatorSummary } from "@crane/contracts";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";

/** How a host command gets a new password: typed twice, one line of stdin, or made up and shown once. */
export interface PasswordOptions {
  passwordStdin?: boolean;
  generate?: boolean;
}

export type NewPassword = { password: string; generated: boolean };

/** Runs `fn`, turning a refused action into the CLI's one-line failure. */
export async function attempt(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ui.fail(errorMessage(err));
  }
}

/** The operator a username names, compared without case. */
export function findOperator({ actions }: CliContext, username: string): OperatorSummary {
  const wanted = normalizeUsername(username);
  return actions.listOperators().find((o) => o.username === wanted)
    ?? ui.fail(`No operator ${username}. See \`crane operators\`.`);
}

export const roleWords = (role: OperatorRole) => (role === "admin" ? "an admin" : "an operator");
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "7 days" or "24 hours": how long until `iso`, rounded to what reads naturally. */
export function expiresIn(iso: string, now = Date.now()): string {
  const hours = Math.max(0, Math.round((Date.parse(iso) - now) / 3_600_000));
  return hours > 48 ? plural(Math.round(hours / 24), "day") : plural(hours, "hour");
}

/** The path a join or reset link opens. The token rides in the fragment, which browsers never send to a server. */
export const linkPath = (token: string) => `/join#${token}`;

export function printLink(title: string, token: string, expiresAt: string): void {
  ui.ok(`${title} ${ui.dim(`(expires in ${expiresIn(expiresAt)})`)}`);
  console.log(`  ${linkPath(token)}`);
  console.log(ui.dim("  Open it at your dashboard's address, for example https://crane.example.com/join#…"));
  console.log(ui.dim("  It works once. Crane keeps only a digest of it, so this is the only time it's shown."));
}

export async function newPassword(ctx: CliContext, opts: PasswordOptions): Promise<NewPassword> {
  if (opts.passwordStdin && opts.generate) ui.fail("Choose --password-stdin or --generate");
  if (opts.generate) return { password: ctx.actions.generatePassword(), generated: true };
  if (opts.passwordStdin) return { password: await ctx.io.readLine(), generated: false };
  if (!process.stdin.isTTY) ui.fail("There's no terminal to type a password in. Pass --password-stdin or --generate.");
  const first = await p.password({ message: "Password (at least 12 characters)" });
  if (p.isCancel(first)) ui.fail("Cancelled");
  const again = await p.password({ message: "Type it again" });
  if (p.isCancel(again)) ui.fail("Cancelled");
  if (first !== again) ui.fail("The passwords don't match");
  return { password: first, generated: false };
}

/** Shown once, straight after it's set: Crane keeps only the hash. */
export function printGenerated(username: string, password: string): void {
  console.log(`  ${ui.dim("Password for")} ${username}  ${ui.bold(password)}`);
  console.log(ui.dim("  Copy it now. Crane keeps only its hash, so this is the only time it's shown."));
}

/** True when `--yes` was given or the operator agrees at the terminal. Without a terminal, asks for `--yes`. */
export async function confirmed(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) ui.fail("Pass --yes to confirm");
  const answer = await p.confirm({ message: question, initialValue: false });
  return !p.isCancel(answer) && answer;
}
