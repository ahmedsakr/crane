import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "@crane/contracts";
import { buildsDir, factoryRoot } from "../core/paths.js";
import { BUILD_MANIFEST, dashboardBuilds, webBuildOutdated } from "../core/webbuild.js";
import { installDependencies } from "./deps.js";
import { git } from "../core/git.js";

const run = promisify(execFile);

/**
 * Crane builds its own dashboard.
 *
 * The dashboard on Crane's port used to come only from `web/dist` in the
 * operator's checkout, so a merged UI fix didn't show until someone ran
 * `npm run build` there. Now, after a change to Crane's own repo is merged,
 * Crane builds that commit in a directory of its own and serves it (see
 * `servedDashboard`):
 *
 *   1. Check the commit out, detached, in a scratch worktree under
 *      `$CRANE_HOME/builds/.work/<sha>`. Never the operator's checkout.
 *   2. Put dependencies in place, copying them from the checkout when it has
 *      installed exactly what the commit's lockfile pins (`deps.ts`).
 *   3. Build the web app into `$CRANE_HOME/builds/<sha>/dist.tmp`, write the
 *      manifest, and rename `dist.tmp` to `dist`. Only then is it served.
 *   4. Remove the scratch worktree and all but the newest few builds.
 */

/** Builds the web app from the checkout at `cwd` into `outDir`. */
export type BuildWeb = (cwd: string, outDir: string, signal?: AbortSignal) => Promise<void>;

/** How many finished builds to keep, so an open page can still load its assets after a newer one lands. */
const KEEP_BUILDS = 3;

const npmBuild: BuildWeb = async (cwd, outDir, signal) => {
  await run("npm", ["run", "build", "-w", "web", "--", "--outDir", outDir, "--emptyOutDir"], {
    cwd,
    signal,
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
};

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

export const shortSha = (sha: string) => sha.slice(0, 7);

/** The useful line out of a failed command, for the activity feed. */
function why(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr?.trim() || e.message || String(err)).split("\n").map((l) => l.trim());
  const error = text.find((l) => /error/i.test(l) && !l.startsWith("Command failed"));
  return (error ?? text.find((l) => l && !l.startsWith("Command failed")) ?? "the build failed").slice(0, 300);
}

/**
 * Build the dashboard from `sha` of `repo`. Returns where it landed. Does
 * nothing if that commit is already built. Throws if the build fails, leaving
 * no partial build behind.
 */
export async function buildDashboard(
  repo: Repo,
  sha: string,
  opts: { builds?: string; signal?: AbortSignal; build?: BuildWeb } = {},
): Promise<string> {
  const builds = opts.builds ?? buildsDir();
  const out = join(builds, sha);
  const dist = join(out, "dist");
  if (dashboardBuilds(builds).some((b) => b.sha === sha)) return dist;

  const work = join(builds, ".work", sha);
  await removeScratch(repo, work);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(builds, ".work"), { recursive: true });
  await git(repo.path, "worktree", "add", "--detach", "--quiet", work, sha);
  try {
    await installDependencies(work, { from: repo.path, signal: opts.signal });
    const tmp = join(out, "dist.tmp");
    await mkdir(out, { recursive: true });
    await (opts.build ?? npmBuild)(work, tmp, opts.signal);
    if (!existsSync(join(tmp, "index.html"))) throw new Error("The build didn't produce an index.html");
    opts.signal?.throwIfAborted();
    await writeFile(join(out, BUILD_MANIFEST), JSON.stringify({ sha, builtAt: Date.now() }) + "\n");
    await rename(tmp, dist);
    return dist;
  } catch (err) {
    await rm(out, { recursive: true, force: true });
    throw err;
  } finally {
    await removeScratch(repo, work);
  }
}

/** Remove a scratch worktree, both the directory and git's record of it. */
async function removeScratch(repo: Repo, work: string) {
  if (existsSync(work)) await ok(git(repo.path, "worktree", "remove", "--force", work));
  await rm(work, { recursive: true, force: true });
  await ok(git(repo.path, "worktree", "prune"));
}

/**
 * Whether the dashboard needs building to show `sha`. It doesn't when Crane
 * already built that commit or a later one, or when the checkout's own
 * `web/dist` is up to date with source that already contains it (the
 * operator built it themselves).
 */
export async function dashboardBuildNeeded(
  repo: Repo,
  sha: string,
  opts: { builds?: string; root?: string } = {},
): Promise<boolean> {
  const contains = (later: string) => later === sha || ok(git(repo.path, "merge-base", "--is-ancestor", sha, later));
  for (const b of dashboardBuilds(opts.builds ?? buildsDir())) {
    if (await contains(b.sha)) return false;
  }
  const root = opts.root ?? factoryRoot();
  if (existsSync(join(root, "web", "dist", "index.html")) && !webBuildOutdated(root)) {
    const head = await git(root, "rev-parse", "HEAD").catch(() => null);
    if (head && (await ok(git(root, "merge-base", "--is-ancestor", sha, head)))) return false;
  }
  return true;
}

/**
 * Remove all but the newest few builds. The one being served is always the
 * newest build (or the checkout's own), so it's never removed.
 */
export async function pruneDashboardBuilds(opts: { builds?: string; keep?: number } = {}) {
  const builds = opts.builds ?? buildsDir();
  for (const b of dashboardBuilds(builds).slice(Math.max(1, opts.keep ?? KEEP_BUILDS))) {
    await rm(join(builds, b.sha), { recursive: true, force: true });
  }
}

export interface DashboardBuilderOptions {
  /** Crane's own repo, or null when it isn't a git checkout (an installed package). */
  repo: () => Repo | null;
  log: (line: string) => void;
  /** Tell the operator on a task's feed. */
  note: (taskId: string, message: string) => void;
  builds?: string;
  root?: string;
  build?: BuildWeb;
}

/**
 * Builds the dashboard in the background, one commit at a time. If more
 * merges land while a build runs, only the newest is built next.
 */
export class DashboardBuilder {
  private next: { sha: string; taskId?: string } | null = null;
  private current: Promise<void> | null = null;
  private ac = new AbortController();

  constructor(private opts: DashboardBuilderOptions) {}

  /** On start: build the default branch's tip if the dashboard doesn't show it yet. */
  async start(): Promise<void> {
    const repo = this.opts.repo();
    if (!repo) return;
    const builds = this.opts.builds ?? buildsDir();
    // A factory that stopped mid-build may have left its scratch worktree behind.
    await rm(join(builds, ".work"), { recursive: true, force: true });
    await ok(git(repo.path, "worktree", "prune"));
    const tip = await git(repo.path, "rev-parse", "--verify", "-q", `refs/heads/${repo.defaultBranch}^{commit}`).catch(() => "");
    if (tip) await this.request(tip);
  }

  /** Build `sha` once the current build finishes, if the dashboard doesn't already show it. */
  async request(sha: string, taskId?: string): Promise<void> {
    const repo = this.opts.repo();
    if (!repo || this.ac.signal.aborted) return;
    if (!(await dashboardBuildNeeded(repo, sha, this.opts).catch(() => false))) return;
    this.next = { sha, taskId };
    this.current ??= this.drain().finally(() => (this.current = null));
  }

  /** Stop building. Resolves once the build in progress has cleaned up after itself. */
  async stop(): Promise<void> {
    this.ac.abort();
    this.next = null;
    await this.current;
  }

  /** Wait for every requested build to finish. */
  async idle(): Promise<void> {
    while (this.current) await this.current;
  }

  private async drain() {
    while (this.next && !this.ac.signal.aborted) {
      const { sha, taskId } = this.next;
      this.next = null;
      const repo = this.opts.repo();
      if (!repo) return;
      // Asked for twice, or a later commit got built first.
      if (!(await dashboardBuildNeeded(repo, sha, this.opts).catch(() => false))) continue;
      const short = shortSha(sha);
      const tell = (message: string) => {
        this.opts.log(message);
        if (taskId) this.opts.note(taskId, message);
      };
      tell(`Building the dashboard from ${short}`);
      try {
        await buildDashboard(repo, sha, { builds: this.opts.builds, signal: this.ac.signal, build: this.opts.build });
        await pruneDashboardBuilds({ builds: this.opts.builds }).catch(() => {});
        tell(`The dashboard now shows ${short}. Reload it to see the latest UI`);
      } catch (err) {
        if (this.ac.signal.aborted) return;
        tell(`Couldn't build the dashboard from ${short}: ${why(err)}. It still shows the previous build`);
      }
    }
  }
}
