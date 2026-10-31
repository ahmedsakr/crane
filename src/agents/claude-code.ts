import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentDriver, RunContext, RunResult } from "./driver.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import { parseReport } from "./report.js";
import type { Autonomy } from "../core/types.js";

const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebSearch",
  "WebFetch",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(ls:*)",
  "Bash(wc:*)",
];

const WRITE_TOOLS = [
  ...READ_ONLY_TOOLS,
  "Edit",
  "Write",
  "MultiEdit",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git mv:*)",
  "Bash(git rm:*)",
  "Bash(npm test:*)",
  "Bash(npm run:*)",
  "Bash(npm install:*)",
  "Bash(npx tsc:*)",
  "Bash(node:*)",
  "Bash(python3 -m pytest:*)",
  "Bash(pytest:*)",
  "Bash(make:*)",
  "Bash(cargo test:*)",
  "Bash(go test:*)",
];

/** Never allowed, regardless of autonomy. Crane does not ship code on its own. */
const ALWAYS_DENIED = ["Bash(git push:*)", "Bash(git checkout main:*)", "Bash(git merge:*)", "Bash(rm -rf:*)"];

function toolsFor(autonomy: Autonomy): { allowed: string[]; denied: string[] } {
  const extra = process.env.CRANE_ALLOWED_TOOLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (autonomy === "observe") {
    return { allowed: [...READ_ONLY_TOOLS, ...extra], denied: ["Edit", "Write", "MultiEdit", "NotebookEdit", ...ALWAYS_DENIED] };
  }
  return { allowed: [...WRITE_TOOLS, ...extra], denied: ALWAYS_DENIED };
}

/** Summarise a tool call in a few words for the activity feed. */
function describeTool(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Read":
      return `Read ${s(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Edited ${s(input.file_path)}`;
    case "Write":
      return `Wrote ${s(input.file_path)}`;
    case "Grep":
      return `Searched for “${s(input.pattern)}”`;
    case "Glob":
      return `Listed ${s(input.pattern)}`;
    case "Bash":
      return `Ran ${s(input.command).split("\n")[0]?.slice(0, 120)}`;
    case "WebSearch":
      return `Searched the web for “${s(input.query)}”`;
    case "WebFetch":
      return `Read ${s(input.url)}`;
    case "TodoWrite":
      return "Updated its plan";
    case "Task":
      return `Delegated: ${s(input.description)}`;
    default:
      return name;
  }
}

/**
 * Runs missions through Claude Code in headless mode (`claude -p`), which uses
 * whatever auth the local `claude` CLI already has, a Claude subscription or an
 * API key. Each run streams JSON events that we translate into mission events.
 */
export class ClaudeCodeDriver implements AgentDriver {
  readonly name = "claude-code";
  readonly label = "Claude Code";
  constructor(private bin = process.env.CRANE_CLAUDE_BIN ?? "claude") {}

  available(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, ["--version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    });
  }

  run(ctx: RunContext): Promise<RunResult> {
    const { mission, repo, cwd, emit, signal } = ctx;
    const { allowed, denied } = toolsFor(mission.autonomy);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      systemPrompt(mission, repo),
      "--permission-mode",
      mission.autonomy === "observe" ? "default" : "acceptEdits",
      "--allowedTools",
      allowed.join(","),
      "--disallowedTools",
      denied.join(","),
    ];
    if (process.env.CRANE_MODEL) args.push("--model", process.env.CRANE_MODEL);

    // Don't let a parent Claude Code session's environment leak into the agent.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let finalText = "";
      let lastText = "";
      let costUsd = 0;
      let errored: string | null = null;
      let stderr = "";

      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdin.end(userPrompt(mission));
      child.stderr.on("data", (d) => {
        stderr = (stderr + String(d)).slice(-4000);
      });

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          emit("note", `Agent session started${msg.model ? ` on ${msg.model}` : ""}`, { sessionId: msg.session_id });
        } else if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              lastText = block.text;
              const visible = block.text.split("```crane-report")[0]!.trim();
              if (visible) emit("note", visible.slice(0, 1200));
            } else if (block.type === "tool_use") {
              emit("tool", describeTool(block.name, block.input ?? {}), { tool: block.name });
            }
          }
        } else if (msg.type === "result") {
          costUsd = Number(msg.total_cost_usd ?? 0);
          finalText = typeof msg.result === "string" ? msg.result : lastText;
          if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
            errored = typeof msg.result === "string" ? msg.result : `Agent stopped: ${msg.subtype}`;
          }
        }
      });

      child.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error(`Could not start Claude Code (${this.bin}): ${err.message}`));
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return reject(new Error("Cancelled by operator"));
        if (errored) return reject(new Error(errored));
        if (code !== 0 && !finalText) {
          return reject(new Error(`Claude Code exited with code ${code}. ${stderr.trim().slice(-500)}`));
        }
        resolve({ report: parseReport(finalText || lastText), costUsd });
      });
    });
  }
}
