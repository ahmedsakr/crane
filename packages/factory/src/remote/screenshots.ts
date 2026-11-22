import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { RUNNER_LIMITS, type Screenshot } from "@crane/contracts";
import { worktreesDir } from "@crane/backend-runtime";
import { jobScreenshotDir } from "./paths.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(png|jpe?g|webp)$/i;

/**
 * A real directory, created if missing. The worktree holds the container's
 * commits, so a symlink here could point anywhere: refuse it.
 */
function realDirectory(path: string): void {
  try {
    mkdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The task's screenshot folder isn't a plain folder");
}

/** The task's worktree, which must already exist: Crane made it before sending the job. */
function worktreeOf(taskId: string): string {
  const path = join(worktreesDir(), taskId);
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) return path;
  } catch {
    // Missing is refused below.
  }
  throw new Error("This task has no worktree to attach screenshots to");
}

/**
 * Save one uploaded screenshot in the task's worktree, under the job's own
 * ignored folder, and return its worktree-relative path. The folder ignores
 * itself, so neither Crane's commit of leftover work nor a merge stages it.
 */
export function saveJobScreenshot(taskId: string, jobId: string, name: unknown, bytes: Uint8Array): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("Name the screenshot like shot.png, .jpg or .webp");
  if (!bytes.byteLength) throw new Error("The screenshot is empty");
  if (bytes.byteLength > RUNNER_LIMITS.screenshotBytes) throw new Error("Screenshots can be at most 10 MiB");
  const relative = jobScreenshotDir(jobId);
  let dir = worktreeOf(taskId);
  for (const part of relative.split("/")) realDirectory(dir = join(dir, part));
  try {
    writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const saved = readdirSync(dir).filter((f) => f !== ".gitignore");
  if (saved.length >= RUNNER_LIMITS.screenshotCount) throw new Error(`A job can attach at most ${RUNNER_LIMITS.screenshotCount} screenshots`);
  try {
    // Exclusive, so an existing file or symlink of that name is never written through.
    writeFileSync(join(dir, name), bytes, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A screenshot with that name was already sent");
    throw err;
  }
  return `${relative}/${name}`;
}

/** Point the report's screenshots at the files the job uploaded, matched by file name. */
export function uploadedScreenshots(taskId: string, jobId: string, images: Screenshot[] | undefined): Screenshot[] | undefined {
  if (!images) return undefined;
  const relative = jobScreenshotDir(jobId);
  let uploaded: Set<string>;
  try {
    uploaded = new Set(readdirSync(join(worktreesDir(), taskId, relative)));
  } catch {
    uploaded = new Set();
  }
  return images.map((image) => {
    const name = basename(image.path ?? "");
    return uploaded.has(name) && name !== ".gitignore" ? { ...image, path: `${relative}/${name}` } : image;
  });
}
