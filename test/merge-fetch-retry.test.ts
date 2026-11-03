import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimulatedDriver } from "@crane/agent-drivers";
import type { Repo, Task } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { isTransientFetchFailure, landTask, MergeError, type MergeRequest } from "../src/factory/merge.js";
import { Factory } from "../src/factory/orchestrator.js";
import { sh } from "./support/git.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-fetch-retry-home-"));

const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const DNS_HTTPS = "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com\n";
const DNS_SSH = "ssh: Could not resolve hostname github.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
const BAD_KEY = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n";

function commit(cwd: string, file: string) {
  writeFileSync(join(cwd, file), `${file}\n`);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", file);
  return sh(cwd, "rev-parse", "HEAD");
}

/** A bare origin, a checkout of main, and a task branch with one commit in its own worktree. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-fetch-retry-"));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const wt = join(root, "wt");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, checkout);
  sh(checkout, "checkout", "-q", "-b", "main");
  commit(checkout, "start.txt");
  sh(checkout, "push", "-q", "-u", "origin", "main");
  sh(checkout, "worktree", "add", "-q", "-b", "crane/work-t1", wt);
  commit(wt, "feature.txt");
  const repo = { id: "r-x", name: "x", path: checkout, defaultBranch: "main", isFactory: false, addedAt: "" } as Repo;
  const task = { id: "t-1", title: "Work", branch: "crane/work-t1", worktree: wt } as Task;
  /** Someone else lands work on origin while the task waits. */
  const landElsewhere = () => {
    const other = join(root, "other");
    sh(root, "clone", "-q", origin, other);
    const landed = commit(other, "elsewhere.txt");
    sh(other, "push", "-q", "origin", "HEAD:main");
    return landed;
  };
  return { root, origin, checkout, wt, repo, task, landElsewhere };
}

/**
 * Puts a `git` first on PATH that runs `onFail` for the first `failures` fetches
 * from origin, and hands every other call to the real git. Returns how many
 * fetches from origin it has seen.
 */
function interceptFetches(t: TestContext, root: string, failures: number, onFail: string) {
  const bin = mkdtempSync(join(root, "bin-"));
  const count = join(bin, "count");
  writeFileSync(count, "0");
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = fetch ] && [ "$3" = origin ]; then
  n=$(cat "${count}")
  echo $((n + 1)) > "${count}"
  if [ "$n" -lt ${failures} ]; then
    ${onFail}
  fi
fi
exec "${REAL_GIT}" "$@"
`);
  chmodSync(join(bin, "git"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => { process.env.PATH = before; });
  return () => Number(readFileSync(count, "utf8"));
}

/** Fail the first `failures` fetches from origin with this stderr, as a network or server would. */
function failFetches(t: TestContext, root: string, failures: number, stderr: string) {
  const file = join(mkdtempSync(join(root, "stderr-")), "stderr");
  writeFileSync(file, stderr);
  return interceptFetches(t, root, failures, `cat "${file}" >&2; exit 128`);
}

/** A request with short waits that records its notes and whether each gate ran. */
function request(env: ReturnType<typeof setup>, extra: Partial<MergeRequest> = {}) {
  const notes: { message: string; fetch?: Record<string, unknown> }[] = [];
  const gates = { visual: 0, checks: 0 };
  const req: MergeRequest = {
    repo: env.repo,
    task: env.task,
    workdir: env.wt,
    checks: ["true"],
    fetchRetryDelaysMs: [1, 1],
    emit: (_type, message, data) => void notes.push({ message, fetch: data?.fetch as Record<string, unknown> | undefined }),
    resolveConflicts: async () => { throw new Error("should not be asked to resolve conflicts"); },
    verifyVisualReview: async () => { gates.visual++; },
    recordValidation: () => { gates.checks++; },
    ...extra,
  };
  const outcomes = () => notes.flatMap((n) => (n.fetch ? [`${n.fetch.outcome} ${n.fetch.attempt}/${n.fetch.attempts}`] : []));
  return { req, notes, gates, outcomes };
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("fetch classification: temporary network failures are transient", () => {
  for (const stderr of [
    DNS_HTTPS,
    DNS_SSH,
    "fatal: unable to look up github.com (port 9418) (Temporary failure in name resolution)\n",
    "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n",
    "ssh: connect to host github.com port 22: Network is unreachable\n",
    "ssh: connect to host github.com port 22: No route to host\n",
    "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 130 ms: Couldn't connect to server\n",
    "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 130000 ms: Timeout was reached\n",
    "fatal: unable to access 'https://github.com/o/r.git/': Operation timed out after 300001 milliseconds with 0 bytes received\n",
    "kex_exchange_identification: read: Connection reset by peer\nfatal: Could not read from remote repository.\n",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503\n",
    "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\n",
  ]) {
    assert.equal(isTransientFetchFailure({ stderr }), true, stderr);
  }
  assert.equal(isTransientFetchFailure({ stderr: "", killed: true, signal: "SIGTERM" }), true, "git killed at its time limit");
});

test("fetch classification: authentication, policy, permission and unknown failures aren't", () => {
  for (const stderr of [
    BAD_KEY,
    "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'\n",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
    "Host key verification failed.\nfatal: Could not read from remote repository.\n",
    "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found\n",
    "fatal: 'origin' does not appear to be a git repository\n",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n",
    "fatal: transport 'ext' not allowed\n",
    "remote: Fetching is blocked by your organization's policy.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 500\n",
    "fatal: unable to access 'https://github.com/o/r.git/': SSL certificate problem: unable to get local issuer certificate\n",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 500\n",
    "fatal: something nobody has seen before\n",
    "",
  ]) {
    assert.equal(isTransientFetchFailure({ stderr }), false, stderr);
  }
  assert.equal(
    isTransientFetchFailure({ stderr: "fatal: couldn't find remote ref refs/heads/connection-timed-out\n" }),
    false,
    "a branch name can't make a missing branch look like an outage",
  );
  assert.equal(
    isTransientFetchFailure({ stderr: "Permission denied, and then: Connection timed out\n" }),
    false,
    "a refusal wins when both appear",
  );
  assert.equal(isTransientFetchFailure(new Error("Command failed: git fetch origin connection-timed-out")), false, "the command line doesn't count");
  assert.equal(isTransientFetchFailure(Object.assign(new Error("aborted"), { name: "AbortError", killed: true })), false, "cancelling isn't an outage");
});

test("fetch retry: DNS recovery merges onto what the successful fetch brought, through every gate", async (t) => {
  const env = setup();
  const landed = env.landElsewhere();
  const fetches = failFetches(t, env.root, 2, DNS_HTTPS);
  const { req, gates, notes, outcomes } = request(env);

  const result = await landTask(req);

  assert.equal(fetches(), 3);
  assert.deepEqual(outcomes(), ["retrying 1/3", "retrying 2/3", "recovered 3/3"]);
  const retry = notes.find((n) => n.fetch?.outcome === "retrying")!;
  assert.match(retry.message, /attempt 1 of 3: unable to access .*Could not resolve host: github\.com\. Trying again in 1s$/);
  assert.equal(retry.fetch!.retryInMs, 1);
  assert.equal(sh(env.origin, "rev-parse", "main"), result.commit);
  assert.equal(sh(env.checkout, "rev-parse", `${result.commit}^1`), landed, "built on the commit only the fresh fetch could see");
  assert.equal(gates.visual, 2, "visual decision checked before and after checks");
  assert.equal(gates.checks, 1, "merge checks still ran");
});

test("fetch retry: a merge with no failure records nothing extra", async (t) => {
  const env = setup();
  const fetches = failFetches(t, env.root, 0, DNS_HTTPS);
  const { req, outcomes } = request(env);
  await landTask(req);
  assert.equal(fetches(), 1);
  assert.deepEqual(outcomes(), []);
});

test("fetch retry: exhausted retries stop without using stale refs, reaching a gate, or pushing", async (t) => {
  const env = setup();
  env.landElsewhere();
  const before = sh(env.origin, "rev-parse", "main");
  const localBefore = sh(env.checkout, "rev-parse", "main");
  const trackingBefore = sh(env.checkout, "rev-parse", "refs/remotes/origin/main");
  const fetches = failFetches(t, env.root, 99, DNS_SSH);
  const { req, gates, outcomes } = request(env);

  await assert.rejects(landTask(req), (err: Error) =>
    err instanceof MergeError && err.message === "Couldn't fetch main from origin after 3 attempts: ssh: Could not resolve hostname github.com: Temporary failure in name resolution");

  assert.equal(fetches(), 3, "bounded by the policy");
  assert.deepEqual(outcomes(), ["retrying 1/3", "retrying 2/3", "exhausted 3/3"]);
  assert.deepEqual(gates, { visual: 0, checks: 0 });
  assert.equal(sh(env.origin, "rev-parse", "main"), before);
  assert.equal(sh(env.checkout, "rev-parse", "main"), localBefore);
  assert.equal(sh(env.checkout, "rev-parse", "refs/remotes/origin/main"), trackingBefore);
});

test("fetch retry: a non-transient failure comes back after one attempt", async (t) => {
  const env = setup();
  const before = sh(env.origin, "rev-parse", "main");
  const fetches = failFetches(t, env.root, 99, BAD_KEY);
  const { req, gates, outcomes } = request(env);

  await assert.rejects(landTask(req), (err: Error) =>
    err instanceof MergeError && err.message === "Couldn't fetch main from origin: git@github.com: Permission denied (publickey).");

  assert.equal(fetches(), 1);
  assert.deepEqual(outcomes(), []);
  assert.deepEqual(gates, { visual: 0, checks: 0 });
  assert.equal(sh(env.origin, "rev-parse", "main"), before);
});

test("fetch retry: a refusal partway through the outage ends the retries", async (t) => {
  const env = setup();
  const file = join(env.root, "script-stderr");
  writeFileSync(file, DNS_HTTPS);
  const denied = join(env.root, "denied-stderr");
  writeFileSync(denied, BAD_KEY);
  // First fetch hits DNS, every later one is refused.
  const fetches = interceptFetches(t, env.root, 99, `if [ "$n" -eq 0 ]; then cat "${file}" >&2; else cat "${denied}" >&2; fi; exit 128`);
  const { req, outcomes } = request(env);

  await assert.rejects(landTask(req), /Couldn't fetch main from origin: git@github\.com: Permission denied/);
  assert.equal(fetches(), 2);
  assert.deepEqual(outcomes(), ["retrying 1/3"]);
});

test("fetch retry: cancelling during the wait stops at once, without another fetch or a merge error", async (t) => {
  const env = setup();
  const before = sh(env.origin, "rev-parse", "main");
  const fetches = failFetches(t, env.root, 99, DNS_HTTPS);
  const ac = new AbortController();
  const { req, gates, outcomes } = request(env, { signal: ac.signal, fetchRetryDelaysMs: [60_000] });
  const emit = req.emit;
  req.emit = (type, message, data) => {
    emit(type, message, data);
    if ((data?.fetch as { outcome?: string } | undefined)?.outcome === "retrying") ac.abort();
  };

  const started = Date.now();
  await assert.rejects(landTask(req), (err: Error) => !(err instanceof MergeError) && err.message === "Stopped");

  assert.ok(Date.now() - started < 30_000, "didn't sit out the wait");
  assert.equal(fetches(), 1);
  assert.deepEqual(outcomes(), ["retrying 1/2", "cancelled 1/2"]);
  assert.deepEqual(gates, { visual: 0, checks: 0 });
  assert.equal(sh(env.origin, "rev-parse", "main"), before);
});

test("fetch retry: cancelling stops a fetch that's still running", async (t) => {
  const env = setup();
  const fetches = interceptFetches(t, env.root, 99, "exec sleep 60");
  const ac = new AbortController();
  const { req, gates, outcomes } = request(env, { signal: ac.signal });

  const landing = landTask(req);
  await until(() => fetches() === 1, "the fetch to start");
  const started = Date.now();
  ac.abort();
  await assert.rejects(landing, (err: Error) => !(err instanceof MergeError) && err.message === "Stopped");

  assert.ok(Date.now() - started < 30_000, "didn't wait for the fetch");
  assert.equal(fetches(), 1);
  assert.deepEqual(outcomes(), ["cancelled 1/3"]);
  assert.deepEqual(gates, { visual: 0, checks: 0 });
});

test("fetch retry: stopping the factory during the wait leaves the task queued to merge", async (t) => {
  const env = setup();
  const before = sh(env.origin, "rev-parse", "main");
  const store = new Store(join(env.root, "crane.db"));
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 10 });
  try {
    const repo = await new OperatorActions(store).connectRepo(env.checkout, "x");
    const task = store.createTask({ kind: "maintenance", title: "Work", brief: "", repoId: repo.id, autonomy: "propose" });
    store.updateTask(task.id, { status: "merging", branch: env.task.branch, worktree: env.wt });
    const fetches = failFetches(t, env.root, 99, DNS_HTTPS);
    const events = () => store.listEvents(task.id);

    factory.start();
    await until(() => events().some((e) => e.message.includes("Trying again in 5s")), "the first retry to be recorded");
    await factory.stop();

    assert.equal(fetches(), 1);
    const after = store.getTask(task.id)!;
    assert.equal(after.status, "merging", "the next factory picks it up, with no new approval");
    assert.equal(after.agentId, null);
    assert.equal(events().some((e) => e.type === "error"), false, events().map((e) => e.message).join("\n"));
    assert.ok(events().some((e) => e.message.startsWith("Stopped fetching main from origin")));
    assert.equal(sh(env.origin, "rev-parse", "main"), before);
    assert.ok(existsSync(env.wt), "the worktree is still there");
  } finally {
    await factory.stop();
    store.close();
  }
});
