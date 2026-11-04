import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Repo } from "@crane/contracts";

const run = promisify(execFile);

/** The git calls a merge is made of. Nothing here moves a default branch; that's `landTask` in `merge.ts`. */

/** Network calls must never sit waiting on a password prompt nobody will answer. */
const NET_ENV = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
});

export async function g(cwd: string, args: string[], opts: { net?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: opts.net ? NET_ENV() : process.env,
    timeout: opts.net ? 2 * 60_000 : 60_000,
    signal: opts.signal,
  });
  return stdout.trim();
}

export async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await g(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** The useful line out of a failed git call, for the operator. */
export function why(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const text = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim() || e.message || String(err);
  const lines = text.split("\n").map((l) => l.replace(/^(fatal|error|hint):\s*/, "").trim());
  return lines.find((l) => l && !l.startsWith("Command failed")) ?? "git failed";
}

export const revParse = async (cwd: string, ref: string) => {
  try {
    return await g(cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  } catch {
    return null;
  }
};

export const isAncestor = (cwd: string, a: string, b: string) => succeeds(cwd, ["merge-base", "--is-ancestor", a, b]);

/** Use the operator's git identity when they have one, Crane's otherwise. */
export async function identity(cwd: string): Promise<string[]> {
  return (await succeeds(cwd, ["config", "user.email"])) ? [] : ["-c", "user.name=Crane", "-c", "user.email=crane@localhost"];
}

/** The remote the default branch tracks, or `origin`, or none. */
export async function remoteFor(repo: Repo): Promise<string | null> {
  try {
    const tracked = await g(repo.path, ["config", "--get", `branch.${repo.defaultBranch}.remote`]);
    if (tracked && tracked !== ".") return tracked;
  } catch {
    // not configured
  }
  const remotes = (await g(repo.path, ["remote"]).catch(() => "")).split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : null;
}

export interface DefaultTip {
  sha: string;
  label: string;
  /** Commits on the local default branch that aren't on the remote yet, as a count. */
  ahead: string | null;
  /** Whether the local default branch exists and is behind this tip. */
  localBehind: boolean;
}

/**
 * The newest of the local and remote default branch, from the refs already here.
 * Null when neither exists, "diverged" when neither contains the other.
 */
export async function newestDefault(repo: Repo, remote: string | null): Promise<DefaultTip | "diverged" | null> {
  const main = repo.defaultBranch;
  const local = await revParse(repo.path, `refs/heads/${main}`);
  const upstream = remote ? await revParse(repo.path, `refs/remotes/${remote}/${main}`) : null;
  if (!local && !upstream) return null;
  if (!upstream) return { sha: local!, label: main, ahead: null, localBehind: false };
  if (!local || local === upstream || (await isAncestor(repo.path, local, upstream))) {
    return { sha: upstream, label: `${remote}/${main}`, ahead: null, localBehind: !!local && local !== upstream };
  }
  if (await isAncestor(repo.path, upstream, local)) {
    const ahead = await g(repo.path, ["rev-list", "--count", `${upstream}..${local}`]);
    return { sha: local, label: main, ahead, localBehind: false };
  }
  return "diverged";
}
