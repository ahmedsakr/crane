/**
 * Crane's command guard as a Claude Code PreToolUse hook. The driver runs it
 * as `<node> <this file> <base64url GuardContext>` (see `claude-guard.ts`);
 * Claude Code sends the tool call as JSON on stdin.
 *
 * - A deny answers with JSON, never exit 2 for a decision: exit 2 would show
 *   the model this whole command line, encoded context and all.
 * - An allow comes from "Most commands" or the inspect profile's positive
 *   list (never an auto-mode run) and skips the allowlist.
 * - A pass answers nothing and leaves the call to Claude Code's own rules.
 * - Anything going wrong refuses the call with exit 2. Claude Code treats every
 *   other failure (exit 1, a crash, bad JSON, a timeout) as no decision.
 *
 * It starts once per tool call, so it imports only Node and the classifier.
 * Not exported from the package: only the driver points Claude Code at it.
 */
import { classifyToolCall } from "@crane/agent-policy";
import { decodeGuardContext, GUARD_DENY_PREFIX, hookDecision, livenessLine, parseHookInput } from "./command-guard-protocol.js";

async function readStdin(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main(): Promise<void> {
  let toolUseId: string | null = null;
  try {
    const ctx = decodeGuardContext(process.argv[2]);
    const call = parseHookInput(await readStdin());
    toolUseId = call.toolUseId;
    const verdict = classifyToolCall({ tool: call.tool, input: call.input }, ctx);
    const answer = hookDecision(verdict, ctx.access, ctx.profile);
    if (answer) process.stdout.write(JSON.stringify(answer));
    process.stderr.write(livenessLine(answer?.hookSpecificOutput.permissionDecision ?? "pass", toolUseId));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (toolUseId) process.stderr.write(livenessLine("deny", toolUseId));
    process.stderr.write(`${GUARD_DENY_PREFIX} the guard couldn't check this call (${why}), so it was refused. Don't retry it; report it instead.\n`);
    process.exitCode = 2;
  }
}

await main();
