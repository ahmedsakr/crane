import { setTimeout as sleep } from "node:timers/promises";
import type { Repo } from "@crane/contracts";
import { g, why } from "./merge-git.js";
import { MergeError, type MergeRequest } from "./merge-request.js";

/** Update the remote-tracking ref for the default branch. Touches no local branch or checkout. */
export async function fetchDefault(repo: Repo, remote: string, signal?: AbortSignal): Promise<void> {
  const main = repo.defaultBranch;
  await g(repo.path, ["fetch", "--quiet", remote, `+refs/heads/${main}:refs/remotes/${remote}/${main}`], { net: true, signal });
}

/** About a minute in all, since a merge holds its crew member and its repo's merge slot while it waits. */
const FETCH_RETRY_DELAYS_MS = [5_000, 15_000, 40_000];

/**
 * Refusals a retry can't fix: credentials, access, policy, or a missing repo or
 * branch. These win over TRANSIENT_FETCH, because a branch name or server message
 * can contain anything. Not "Could not read from remote repository": ssh failures
 * of every kind end with it, including DNS ones.
 */
const PERMANENT_FETCH = /authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied|host key verification failed|repository not found|does not appear to be a git repository|couldn't find remote ref|not allowed|\bpolicy\b|returned error: 4\d\d|RPC failed; HTTP 4\d\d/i;

/** DNS, connection and gateway failures, in the wording of git, curl, ssh and the system resolver. */
const TRANSIENT_FETCH = /could not resolve host|temporary failure in name resolution|connection timed out|operation timed out|timeout was reached|connection reset by peer|network is unreachable|no route to host|couldn't connect to server|returned error: 50[234]|RPC failed; HTTP 50[234]/i;

/**
 * Whether a failed fetch is worth trying again. Only git's own stderr counts, since
 * an error's message also holds the command line. Anything unrecognized, including
 * translated wording, isn't transient and comes back to the operator right away.
 */
export function isTransientFetchFailure(err: unknown): boolean {
  const e = err as { name?: string; stderr?: unknown; killed?: boolean };
  if (e.name === "AbortError") return false;
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  if (PERMANENT_FETCH.test(stderr)) return false;
  // Node kills git at the time limit in g(), which is what a hung connection looks like.
  return !!e.killed || TRANSIENT_FETCH.test(stderr);
}

/** The fetch a merge depends on: retried only for temporary failures, with every attempt on the task's record. */
export async function fetchForMerge(req: MergeRequest, remote: string): Promise<void> {
  const { repo, emit, signal } = req;
  const main = repo.defaultBranch;
  const delays = req.fetchRetryDelaysMs ?? FETCH_RETRY_DELAYS_MS;
  const attempts = delays.length + 1;
  const record = (outcome: "retrying" | "recovered" | "exhausted" | "cancelled", attempt: number, message: string, details: Record<string, unknown> = {}) =>
    emit("note", message, { fetch: { outcome, attempt, attempts, ...details } });
  const stopped = (attempt: number) => {
    record("cancelled", attempt, `Stopped fetching ${main} from ${remote} on attempt ${attempt} of ${attempts}`);
    return new Error("Stopped");
  };

  for (let attempt = 1; ; attempt++) {
    try {
      await fetchDefault(repo, remote, signal);
      if (attempt > 1) record("recovered", attempt, `Fetched ${main} from ${remote} on attempt ${attempt} of ${attempts}`);
      return;
    } catch (err) {
      if (signal?.aborted) throw stopped(attempt);
      const reason = (err as { killed?: boolean }).killed ? "git fetch timed out" : why(err);
      if (!isTransientFetchFailure(err)) throw new MergeError(`Couldn't fetch ${main} from ${remote}: ${reason}`);
      const wait = delays[attempt - 1];
      if (wait === undefined) {
        record("exhausted", attempt, `Couldn't fetch ${main} from ${remote} on attempt ${attempt} of ${attempts}: ${reason}. No tries left`, { reason });
        throw new MergeError(`Couldn't fetch ${main} from ${remote} after ${attempts} attempts: ${reason}`);
      }
      record("retrying", attempt, `Couldn't fetch ${main} from ${remote} on attempt ${attempt} of ${attempts}: ${reason}. Trying again in ${Math.ceil(wait / 1000)}s`, { reason, retryInMs: wait });
      try {
        await sleep(wait, undefined, { signal });
      } catch {
        throw stopped(attempt);
      }
    }
  }
}
