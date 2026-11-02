import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fake `claude` that records its arguments and replays the supplied JSON events. */
export function fakeClaude(lines: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "crane-fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(join(dir, "lines.json"), JSON.stringify(lines));
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
for (const l of JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "lines.json"))}, "utf8"))) console.log(JSON.stringify(l));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, args: () => JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[] };
}

/** A stand-in `claude` that fails to resume, the way it does when a session's history is gone. */
export function fakeResumingClaude(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "crane-fake-claude-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("--resume")) {
  process.stderr.write("No conversation found with session ID: " + args[args.indexOf("--resume") + 1] + "\\n");
  process.exit(1);
}
const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
say({ type: "system", subtype: "init", session_id: "fresh-session", model: "fake" });
say({ type: "result", subtype: "success", total_cost_usd: 0.25, result: "Done.\\n\\n\`\`\`crane-report\\n{\\"summary\\":\\"All good\\",\\"findings\\":[],\\"changedFiles\\":[]}\\n\`\`\`" });
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const REPORT = '```crane-report\\n{\\"summary\\":\\"Codex did it\\",\\"findings\\":[{\\"title\\":\\"One thing\\",\\"detail\\":\\"d\\",\\"impact\\":\\"high\\",\\"effort\\":\\"small\\"}],\\"changedFiles\\":[]}\\n```';

/**
 * A stand-in `codex` that logs its arguments and stdin, then plays back the
 * JSON events `codex exec --json` sends. `mode` picks the story.
 */
export function fakeCodex(mode: "ok" | "lost-session" | "turn-failed" | "overloaded" | "multi-turn"): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "crane-fake-codex-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.99.0"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + "\\n");
  const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  if (${JSON.stringify(mode)} === "lost-session" && args.includes("resume")) {
    say({ type: "error", message: "No saved session found" });
    process.exit(1);
  }
  say({ type: "thread.started", thread_id: "thread-1" });
  say({ type: "turn.started" });
  if (${JSON.stringify(mode)} === "turn-failed") {
    say({ type: "turn.failed", error: { message: "You've hit your usage limit." } });
    process.exit(1);
  }
  if (${JSON.stringify(mode)} === "overloaded") {
    say({ type: "turn.failed", error: { message: "API Error: 529 overloaded_error" } });
    process.exit(1);
  }
  say({ type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc 'npm test'", status: "in_progress" } });
  say({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc 'npm test'", exit_code: 0, status: "completed" } });
  const cwd = args[args.indexOf("--cd") + 1];
  say({ type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: cwd + "/src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }] } });
  say({ type: "item.completed", item: { id: "i3", type: "reasoning", text: "thinking" } });
  say({ type: "item.completed", item: { id: "i4", type: "agent_message", text: "Fixed it.\\n\\n${REPORT}" } });
  say({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } });
  if (${JSON.stringify(mode)} === "multi-turn") {
    say({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } });
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}
