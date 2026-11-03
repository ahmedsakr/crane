import { errorMessage } from "@crane/contracts";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { craneHome } from "./paths.js";
import type { Screenshot } from "@crane/contracts";
import type { Store } from "./store.js";

const MAX_IMAGES = 12;
const MAX_BYTES = 10 * 1024 * 1024;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** Only generated filenames are addressable, never arbitrary paths from a report or URL. */
export function screenshotPath(taskId: string, name: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId) || !/^[a-f0-9-]{36}\.(png|jpe?g|webp)$/.test(name)) return null;
  return join(craneHome(), "attachments", taskId, name);
}

/** Read a bounded regular file without following a final symlink or blocking on a pipe. */
function readImage(root: string, path: string): { bytes: Buffer; mime: string } {
  const real = realpathSync(path);
  if (!real.startsWith(realpathSync(root) + sep)) throw new Error("Image must be inside its task directory");
  const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) throw new Error("Image must be a regular file of at most 10 MiB");
    const bytes = readFileSync(fd);
    const ext = extname(path).toLowerCase();
    const valid = ext === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ext === ".jpg" || ext === ".jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : ext === ".webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid || bytes.length > MAX_BYTES) throw new Error("Expected a PNG, JPEG, or WebP image");
    return { bytes, mime: MIME[ext]! };
  } finally {
    closeSync(fd);
  }
}

/** Copy agent images out of the disposable worktree before review or cleanup. Failures remain visible notes. */
export function retainScreenshots(taskId: string, worktree: string, images: Screenshot[], note: (message: string) => void): Screenshot[] {
  const retained: Screenshot[] = [];
  if (images.length > MAX_IMAGES) note(`Only the first ${MAX_IMAGES} screenshots can be attached`);
  for (const image of images.slice(0, MAX_IMAGES)) {
    try {
      if (!image.path || isAbsolute(image.path) || /[\\:\0]/.test(image.path) || image.path.split("/").some(p => p === ".." || p === ".git")) {
        throw new Error("Use a worktree-relative image path");
      }
      const source = resolve(worktree, image.path);
      const { bytes } = readImage(worktree, source);
      const name = randomUUID() + extname(source).toLowerCase();
      const target = screenshotPath(taskId, name);
      if (!target) throw new Error("Invalid task attachment name");
      const dir = join(craneHome(), "attachments", taskId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, bytes, { flag: "wx" });
      retained.push({ path: name, caption: image.caption });
    } catch (err) {
      note(`Couldn't attach screenshot ${image.path}: ${errorMessage(err)}`);
    }
  }
  return retained;
}

export function readScreenshot(taskId: string, name: string): { bytes: Buffer; mime: string } | null {
  const path = screenshotPath(taskId, name);
  if (!path) return null;
  try {
    return readImage(join(craneHome(), "attachments", taskId), path);
  } catch {
    return null;
  }
}

/**
 * Only discard generated, unreferenced files older than a day. The grace period
 * covers copies not yet committed to a report (including a crashed run).
 * Never follow directory symlinks or recursively remove unexpected contents.
 */
export function pruneOrphanScreenshots(store: Store, now = Date.now()): number {
  const root = join(craneHome(), "attachments");
  try { if (!lstatSync(root).isDirectory()) return 0; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0; throw err; }
  let removed = 0;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(dir.name)) continue;
    // Report replacement is serialized with the reference check and unlink.
    store.transaction(() => {
      const task = store.getTask(dir.name);
      if (task && ["queued", "running", "merging"].includes(task.status)) return;
      if (store.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND outcome = 'running'").get(dir.name)) return;
      const referenced = new Set(task?.report?.screenshots?.map(image => image.path) ?? []);
      for (const file of readdirSync(join(root, dir.name), { withFileTypes: true })) {
        if (!file.isFile() || referenced.has(file.name)) continue;
        const path = screenshotPath(dir.name, file.name);
        if (!path) continue;
        try {
          const stat = lstatSync(path);
          if (stat.isFile() && stat.mtimeMs < now - 86_400_000) {
            unlinkSync(path);
            removed++;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }, { immediate: true });
  }
  return removed;
}
