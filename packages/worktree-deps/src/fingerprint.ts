import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCKFILES, lockfileFor } from "./lockfile.js";
import { packageDirs } from "./package-dirs.js";

// Kept under node_modules so it is untracked and disappears with the install.
export const PREPARED = "node_modules/.crane-dependencies";

/** Include manifests as well as locks: workspace names/paths can change independently. */
export async function dependencyFingerprint(path: string): Promise<string> {
  const files = (await packageDirs(path)).flatMap(d =>
    ["package.json", ...LOCKFILES.map(l => l.file)].map(f => join(d, f)),
  );
  files.push("pnpm-workspace.yaml", ".npmrc", ".yarnrc.yml");
  const inputs = await Promise.all(files.sort().map(async (file): Promise<FingerprintInput> => {
    const contents = await readFile(join(path, file), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    return [file, contents];
  }));
  const hashed = lockfileFor(path)?.file === "package-lock.json" ? withoutBuildScripts(inputs) : inputs;
  return createHash("sha256").update(JSON.stringify(hashed)).digest("hex");
}

type FingerprintInput = [file: string, contents: string | null];

/** Build and dev entry points that nothing runs during an install, unless a hook below calls them. */
const BUILD_SCRIPT = /^(build|dev)(:.+)?$/;

/**
 * Everything `npm ci` runs from a project's own manifests. Any of these could
 * call a build script, so a build script's text is an install input when one exists.
 */
const INSTALL_HOOKS = new Set([
  "preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare",
  "predependencies", "dependencies", "postdependencies",
]);

/**
 * Drop build and dev scripts from the manifests so editing them keeps an install
 * reusable. Only for npm, whose hooks are listed above. Returns `inputs` untouched
 * if any manifest has an install hook or can't be read, because a hook in one
 * package can run another package's build. Everything else in a manifest still
 * counts, though parsing it means formatting alone no longer does.
 */
function withoutBuildScripts(inputs: FingerprintInput[]): FingerprintInput[] {
  const result: FingerprintInput[] = [];
  for (const [file, contents] of inputs) {
    const isManifest = file === "package.json" || file.endsWith("/package.json");
    const kept = contents !== null && isManifest ? manifestWithoutBuildScripts(contents) : contents;
    if (contents !== null && kept === null) return inputs;
    result.push([file, kept]);
  }
  return result;
}

/** The manifest without its build and dev scripts, or null when they can't safely be ignored. */
function manifestWithoutBuildScripts(contents: string): string | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isRecord(manifest)) return null;
  if (manifest.scripts === undefined) return JSON.stringify(manifest);
  if (!isRecord(manifest.scripts)) return null;
  const scripts = Object.entries(manifest.scripts);
  if (scripts.some(([name]) => INSTALL_HOOKS.has(name))) return null;
  const kept = scripts.filter(([name, script]) => !(typeof script === "string" && BUILD_SCRIPT.test(name)));
  const stripped: Record<string, unknown> = { ...manifest, scripts: Object.fromEntries(kept) };
  // A manifest that only had build scripts matches one that never had any.
  if (kept.length === 0) delete stripped.scripts;
  return JSON.stringify(stripped);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
