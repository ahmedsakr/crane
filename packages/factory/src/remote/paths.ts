import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { craneHome } from "@crane/backend-runtime";

/** Job ids are Crane's own (`j-…`); anything else never names a file. */
function safeJobId(jobId: string): string {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(jobId)) throw new Error("Choose a container job");
  return jobId;
}

function dir(name: string): string {
  const path = join(craneHome(), name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Where a container's returned bundle waits until the factory checks and applies it. */
export function incomingBundlePath(jobId: string): string {
  return join(dir("runner-incoming"), `${safeJobId(jobId)}.bundle`);
}

/** Where bundles Crane sends to containers are built, one file per download. */
export function outgoingBundleDir(): string {
  return dir("runner-outgoing");
}

/** The ref a returned commit is fetched into while Crane checks it. Never a branch. */
export function incomingRef(jobId: string): string {
  return `refs/crane/incoming/${createHash("sha256").update(safeJobId(jobId)).digest("hex")}`;
}

/** Worktree-relative directory a job's uploaded screenshots go in, so `retainScreenshots` can read them. */
export function jobScreenshotDir(jobId: string): string {
  return `.crane/screenshots/${safeJobId(jobId)}`;
}
