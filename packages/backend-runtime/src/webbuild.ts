import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildsDir } from "./paths.js";

/** UI source the build depends on, relative to `web/`. */
const SOURCES = ["src", "index.html", "vite.config.ts", "package.json"];
/** What a workspace package is compiled from, relative to its directory. */
const PACKAGE_INPUTS = ["src", "package.json", "tsconfig.json"];
/** The only package the dashboard bundles (checked in tests), relative to the root. */
const DASHBOARD_PACKAGE_INPUTS = PACKAGE_INPUTS.map((f) => join("packages", "contracts", f));

/** Every package's inputs, as absolute paths. An installed tarball has no `packages/`, so none. */
function factoryPackageInputs(root: string): string[] {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages).flatMap((name) => PACKAGE_INPUTS.map((f) => join(packages, name, f)));
}

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

const cache = new Map<string, { at: number; value: boolean }>();

/**
 * Whether the dashboard in a checkout (`web/dist`) is older than the UI source
 * next to it. That happens when a change to Crane's UI lands and nobody
 * rebuilds that checkout. False when there's no build or no source to compare
 * (an installed package, say). Cached briefly since the UI polls.
 */
export function webBuildOutdated(root: string, now = Date.now()): boolean {
  const hit = cache.get(root);
  if (hit && now - hit.at < 5_000) return hit.value;
  const web = join(root, "web");
  const built = join(web, "dist", "index.html");
  let value = false;
  if (existsSync(built) && existsSync(join(web, "src"))) {
    const source = Math.max(
      ...SOURCES.map((s) => newestMtime(join(web, s))),
      ...DASHBOARD_PACKAGE_INPUTS.map((s) => newestMtime(join(root, s))),
    );
    value = source > statSync(built).mtimeMs;
  }
  cache.set(root, { at: now, value });
  return value;
}

/** Capture the build this process loaded; rebuilding on disk doesn't reload it. */
export function createFactoryBuildCheck(root: string, compiled: boolean): (now?: number) => boolean {
  const built = join(root, "dist", "cli", "index.js");
  const loadedAt = compiled && existsSync(built) ? statSync(built).mtimeMs : null;
  let cached: { at: number; value: boolean } | undefined;
  return (now = Date.now()) => {
    if (loadedAt === null) return false;
    if (cached && now - cached.at < 5_000) return cached.value;
    const value = Math.max(
      newestMtime(join(root, "src")),
      ...factoryPackageInputs(root).map(newestMtime),
    ) > loadedAt;
    cached = { at: now, value };
    return value;
  };
}

// ── dashboards Crane builds itself ──────────────────────────

/** A dashboard Crane built from one commit of its own repo. */
export interface DashboardBuild {
  sha: string;
  /** When the build finished, in ms. */
  builtAt: number;
  /** The built web app: `<builds>/<sha>/dist`. */
  dir: string;
}

export const BUILD_MANIFEST = "build.json";
const SHA = /^[0-9a-f]{40,64}$/;

/**
 * Every finished dashboard build, newest first. A build counts once its
 * manifest is written and its `dist` is in place (renamed there as the last
 * step), so a build that's half done or failed is never served.
 */
export function dashboardBuilds(builds = buildsDir()): DashboardBuild[] {
  if (!existsSync(builds)) return [];
  const found: DashboardBuild[] = [];
  for (const name of readdirSync(builds)) {
    if (!SHA.test(name)) continue;
    const dir = join(builds, name, "dist");
    if (!existsSync(join(dir, "index.html"))) continue;
    try {
      const m = JSON.parse(readFileSync(join(builds, name, BUILD_MANIFEST), "utf8")) as { sha?: string; builtAt?: number };
      if (m.sha === name && typeof m.builtAt === "number") found.push({ sha: name, builtAt: m.builtAt, dir });
    } catch {
      // No manifest yet, or a broken one: not a finished build.
    }
  }
  return found.sort((a, b) => b.builtAt - a.builtAt);
}

/** The dashboard Crane serves on its own port. */
export interface ServedDashboard {
  /** The directory index.html and assets come from. */
  dir: string;
  /** Other dashboards, for assets an already-open older page may still ask for. */
  fallbacks: string[];
  /** Changes whenever a different build is served, so open pages know to reload. */
  id: string;
  /** The commit Crane built it from, or null for the checkout's own `web/dist`. */
  commit: string | null;
  /** Older than the source it was built from, so recent UI changes won't show. */
  outdated: boolean;
}

const servedCache = new Map<string, { at: number; value: ServedDashboard | null }>();

/**
 * Which dashboard to serve: whichever was built most recently, out of Crane's
 * own builds of merged commits (`$CRANE_HOME/builds/<sha>`) and the checkout's
 * `web/dist`. After a merge, Crane's build is newest. When the operator runs
 * `npm run build` themselves, theirs is. Null when there's no dashboard at all.
 * Cached for a moment, since every request asks.
 */
export function servedDashboard(root: string, builds = buildsDir(), now = Date.now()): ServedDashboard | null {
  const key = `${root}\0${builds}`;
  const hit = servedCache.get(key);
  if (hit && now - hit.at < 2_000) return hit.value;

  const crane = dashboardBuilds(builds);
  const checkoutDir = join(root, "web", "dist");
  const checkoutIndex = join(checkoutDir, "index.html");
  const checkoutAt = existsSync(checkoutIndex) ? statSync(checkoutIndex).mtimeMs : null;

  let value: ServedDashboard | null = null;
  const newest = crane[0];
  if (newest && (checkoutAt === null || newest.builtAt >= checkoutAt)) {
    value = {
      dir: newest.dir,
      fallbacks: [...crane.slice(1).map((b) => b.dir), ...(checkoutAt === null ? [] : [checkoutDir])],
      id: newest.sha,
      commit: newest.sha,
      outdated: false,
    };
  } else if (checkoutAt !== null) {
    value = {
      dir: checkoutDir,
      fallbacks: crane.map((b) => b.dir),
      id: `checkout-${Math.round(checkoutAt)}`,
      commit: null,
      outdated: webBuildOutdated(root, now),
    };
  }
  servedCache.set(key, { at: now, value });
  return value;
}
