import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where Crane keeps its state. Override with CRANE_HOME. */
export function craneHome(): string {
  const dir = process.env.CRANE_HOME ?? join(homedir(), ".crane");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return join(craneHome(), "crane.db");
}

export function worktreesDir(): string {
  const dir = join(craneHome(), "worktrees");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Dashboards Crane has built from merged commits of its own repo, one directory per commit. */
export function buildsDir(): string {
  const dir = join(craneHome(), "builds");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The root of the Crane checkout itself (used to register the factory as a repo). */
export function factoryRoot(): string {
  // src/core/paths.ts or dist/core/paths.js -> two levels up
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const DEFAULT_PORT = 4471;
/** Loopback only: the dashboard has no login, so exposing it is the operator's explicit choice (`crane serve --host`). */
export const DEFAULT_HOST = "127.0.0.1";
