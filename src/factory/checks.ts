import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ValidationRun } from "../core/types.js";
import { git } from "./git.js";

const exec = promisify(execFile);

/** Only operator settings supply commands. Agents cannot configure these gates. */
export async function runChecks(cwd: string, commands: string[], phase: ValidationRun["phase"],
  record: (run: ValidationRun) => void, signal?: AbortSignal): Promise<void> {
  const commit = await git(cwd, "rev-parse", "HEAD");
  const results: ValidationRun[] = [];
  for (const command of commands.length ? commands : [null]) {
    const start = Date.now();
    let result: ValidationRun = { phase, commit, command, status: "unconfigured", exitCode: null,
      logs: "No repository checks configured by the operator", durationMs: 0 };
    if (command) {
      try {
        const out = await exec("/bin/sh", ["-c", command], { cwd, signal, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
        result = { ...result, status: "passed", exitCode: 0, logs: out.stdout + out.stderr };
      } catch (error) {
        const e = error as { code?: number | string; stdout?: string; stderr?: string; message: string };
        result = { ...result, status: typeof e.code === "number" && e.code !== 126 && e.code !== 127 ? "failed" : "blocked",
          exitCode: typeof e.code === "number" ? e.code : null,
          logs: `${e.stdout ?? ""}${e.stderr ?? ""}\n${e.message}` };
      }
    }
    result.durationMs = Date.now() - start;
    results.push(result);
    record(result);
  }
  // A command that edits or commits code has not verified the candidate we will push.
  if (await git(cwd, "rev-parse", "HEAD") !== commit || await git(cwd, "status", "--porcelain", "--untracked-files=no")) {
    const result: ValidationRun = { phase, commit, command: null, status: "blocked", exitCode: null,
      logs: "Checks changed the candidate commit or tracked files", durationMs: 0 };
    record(result);
    results.push(result);
  }
  if (results.some(r => r.status !== "passed")) throw new Error(`Repository checks did not pass (${results.filter(r => r.status !== "passed").map(r => r.status).join(", ")})`);
}
