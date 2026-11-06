import { spawn } from "node:child_process";
import { Command } from "commander";
import pc from "picocolors";

export const MIN_NODE_VERSION = "20.19.0";
const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface SetupCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "info";
  detail: string;
  fix?: string;
}

export interface SetupReport {
  ready: boolean;
  checks: SetupCheck[];
  unchecked: string[];
}

/** No shell, login, network request, or captured CLI output. Bound hung version checks. */
export function probeCommand(bin: string, launch = spawn): Promise<ProbeResult> {
  return new Promise(resolve => {
    try {
      const child = launch(bin, ["--version"], {
        stdio: "ignore", timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL",
      });
      child.once("error", (error: NodeJS.ErrnoException) => resolve({
        ok: false,
        detail: error.code === "ENOENT" ? "Executable not found" : `Could not run version check (${error.code ?? "spawn error"})`,
      }));
      child.once("exit", (code, signal) => resolve({
        ok: code === 0 && signal === null,
        detail: probeExitDetail(code, signal),
      }));
    } catch {
      resolve({ ok: false, detail: "Could not start version check" });
    }
  });
}

function probeExitDetail(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `Version check stopped by ${signal} (limit: ${PROBE_TIMEOUT_MS / 1000}s)`;
  if (code === 0) return "Version check passed";
  return `Version check exited with ${code ?? "unknown status"}`;
}

/** Loading the JS wrapper alone doesn't prove its native binding matches this Node runtime. */
export async function probeSqlite(): Promise<ProbeResult> {
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    try {
      db.prepare("SELECT 1").get();
    } finally {
      db.close();
    }
    return { ok: true, detail: "Native binding loaded and in-memory query passed" };
  } catch {
    return { ok: false, detail: "Could not load or query better-sqlite3 with this Node runtime" };
  }
}

interface SetupRuntime {
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  command: (bin: string) => Promise<ProbeResult>;
  sqlite: () => Promise<ProbeResult>;
}

export async function inspectSetup(runtime: SetupRuntime = {
  nodeVersion: process.versions.node, env: process.env, command: probeCommand, sqlite: probeSqlite,
}): Promise<SetupReport> {
  const version = runtime.nodeVersion.split(".").map(Number);
  const minimum = MIN_NODE_VERSION.split(".").map(Number);
  const nodeOk = version.length === 3 && version.every(Number.isInteger) &&
    (version[0]! > minimum[0]! || (version[0] === minimum[0] &&
      (version[1]! > minimum[1]! || (version[1] === minimum[1] && version[2]! >= minimum[2]!))));
  const [npm, git, sqlite, claude, codex] = await Promise.all([
    runtime.command("npm"), runtime.command("git"), runtime.sqlite(),
    runtime.command(runtime.env.CRANE_CLAUDE_BIN ?? "claude"),
    runtime.command(runtime.env.CRANE_CODEX_BIN ?? "codex"),
  ]);
  const required = (id: string, label: string, result: ProbeResult, fix: string): SetupCheck => ({
    id, label, status: result.ok ? "pass" : "fail", detail: result.detail, ...(!result.ok ? { fix } : {}),
  });
  const agent = (id: string, label: string, result: ProbeResult, fix: string): SetupCheck => ({
    ...required(id, label, result, fix), status: result.ok ? "pass" : "info",
  });
  const checks: SetupCheck[] = [
    required("node", "Node.js", { ok: nodeOk, detail: `${runtime.nodeVersion}; requires >=${MIN_NODE_VERSION}` },
      `Install Node.js ${MIN_NODE_VERSION} or newer, then reinstall Crane's dependencies for that runtime.`),
    required("npm", "npm", npm, "Install npm with Node.js and make sure npm is on PATH."),
    required("git", "Git", git, "Install Git with worktree support and make sure git is on PATH: https://git-scm.com/downloads"),
    required("sqlite", "SQLite (better-sqlite3)", sqlite,
      "Reinstall Crane with the current Node.js runtime. In a source checkout, run npm install; for a global install, run npm install -g crane. A separate sqlite3 executable is not needed."),
    agent("claude-code", "Claude Code", claude,
      "Install Claude Code (https://code.claude.com), then run claude to log in. Check CRANE_CLAUDE_BIN if set."),
    agent("codex", "Codex", codex,
      "Run npm install -g @openai/codex, then codex login. Check CRANE_CODEX_BIN if set."),
    required("agent", "At least one real agent", {
      ok: claude.ok || codex.ok,
      detail: claude.ok || codex.ok ? "A real agent CLI is available; login has not been checked"
        : "Neither Claude Code nor Codex works here; Crane can only run simulated agents",
    }, "Install and log in to either Claude Code or Codex using the steps above. You only need one."),
  ];
  return {
    ready: checks.every(check => check.status !== "fail"), checks,
    unchecked: ["Agent login and API access", "Git remote access", "Repository-specific tools and package managers", "Optional screenshot browser tools"],
  };
}

const CHECK_MARK: Record<SetupCheck["status"], () => string> = {
  pass: () => pc.green("✓"),
  fail: () => pc.red("✕"),
  info: () => pc.dim("○"),
};

/** Kept independent of Store and workspace packages so setup can diagnose a broken installation. */
export function setupCommand(inspect = inspectSetup): Command {
  return new Command("setup")
    .description("Check system dependencies without installing or changing anything")
    .option("--json", "print machine-readable checks")
    .action(async (opts: { json?: boolean }) => {
      const report = await inspect();
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log("\nCrane setup\n");
        for (const check of report.checks) {
          console.log(`  ${CHECK_MARK[check.status]()} ${check.label}: ${check.detail}`);
          if (check.fix) console.log(`    ${check.fix}`);
        }
        console.log(`\n${report.ready ? "Required dependencies are available." : "Setup needs attention. Fix the failed checks and rerun crane setup."}`);
        console.log(`Not checked: ${report.unchecked.join("; ")}.\n`);
      }
      process.exitCode = report.ready ? 0 : 1;
    });
}
