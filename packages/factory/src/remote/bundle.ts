import { randomBytes } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "@crane/backend-runtime";
import type { RunnerJobRecord, Store } from "@crane/storage";
import { isAncestor, succeeds } from "../merge-git.js";
import { outgoingBundleDir } from "./paths.js";
import type { JobPayload } from "./payload.js";

/** A bundle built for one download. The caller streams `path`, then calls `remove`. */
export interface OutgoingBundle {
  path: string;
  bytes: number;
  /** The refs it holds, by role, so the container can find each commit it was sent. */
  refs: Record<string, string>;
  remove: () => void;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_HAVES = 64;

/** The commits a job is built from, by role: what the container checks out, merges or fixes. */
function jobCommits(payload: JobPayload): Record<string, string> {
  const commits: Record<string, string> = { base: payload.base };
  if (payload.tip) commits.tip = payload.tip;
  if (payload.job?.kind === "resolve_conflicts" && payload.job.checkpoint) commits.checkpoint = payload.job.checkpoint;
  return commits;
}

/** The commits the container says it already has that Crane also has. Anything else is ignored. */
async function knownHaves(cwd: string, have: unknown): Promise<string[]> {
  if (!Array.isArray(have)) return [];
  const candidates = [...new Set(have.filter((h): h is string => typeof h === "string" && SHA.test(h)))].slice(0, MAX_HAVES);
  const known: string[] = [];
  for (const sha of candidates) if (await succeeds(cwd, ["cat-file", "-e", `${sha}^{commit}`])) known.push(sha);
  return known;
}

/** Whether the container already has `sha`: it is one of its commits or an ancestor of one. */
async function covered(cwd: string, sha: string, haves: string[]): Promise<boolean> {
  for (const h of haves) if (await isAncestor(cwd, sha, h)) return true;
  return false;
}

/**
 * Bundle what a claimed job needs from Crane's repo, leaving out history the
 * container says it has (`have`). Null when it already has everything. Bundles
 * can only hold refs, so each commit gets a temporary ref under
 * `refs/crane/outgoing/`, removed again before this returns.
 */
export async function bundleFor(store: Store, job: RunnerJobRecord, have?: unknown): Promise<OutgoingBundle | null> {
  const task = store.getTask(job.taskId);
  const repo = task?.repoId ? store.getRepo(task.repoId) : null;
  if (!repo) throw new Error("This job's task has no repo");
  const cwd = repo.path;
  const haves = await knownHaves(cwd, have);
  const nonce = randomBytes(6).toString("hex");
  const prefix = `refs/crane/outgoing/${job.id}-${nonce}`;
  const refs: Record<string, string> = {};
  for (const [role, sha] of Object.entries(jobCommits(job.payload as JobPayload))) {
    if (!(await covered(cwd, sha, haves))) refs[role] = `${prefix}/${role}`;
  }
  if (!Object.keys(refs).length) return null;
  const path = join(outgoingBundleDir(), `${job.id}-${nonce}.bundle`);
  const commits = jobCommits(job.payload as JobPayload);
  try {
    for (const [role, ref] of Object.entries(refs)) await git(cwd, "update-ref", ref, commits[role]!);
    await git(cwd, "bundle", "create", "--quiet", path, ...Object.values(refs), ...haves.map((h) => `^${h}`));
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  } finally {
    for (const ref of Object.values(refs)) await succeeds(cwd, ["update-ref", "-d", ref]);
  }
  return { path, bytes: statSync(path).size, refs, remove: () => rmSync(path, { force: true }) };
}
