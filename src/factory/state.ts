import type { Overview } from "@crane/contracts";
import { factoryBuildOutdated, servedDashboard } from "../core/webbuild.js";
import { DEFAULT_DRIVER_KEY, HEARTBEAT_KEY } from "./settings.js";

/**
 * Read-only questions about the factory, for the server and CLI. Kept apart
 * from `orchestrator.ts` so asking whether the factory is running doesn't load
 * merging, dependency installs, dashboard builds or the concrete drivers.
 */

/** Whatever can read a setting. The Store is one. */
export interface SettingsReader {
  getSetting(key: string): string | null;
}

/** Whatever can also say whether the operator paused the factory. The Store is one. */
export interface FactoryStateReader extends SettingsReader {
  isPaused(): boolean;
}

/** How recent a heartbeat must be for the factory to count as running. */
const HEARTBEAT_FRESH_MS = 6000;

/** True if a factory process has checked in within the last few seconds. */
export function factoryIsRunning(settings: SettingsReader): boolean {
  const beat = settings.getSetting(HEARTBEAT_KEY);
  return !!beat && Date.now() - Number(beat) < HEARTBEAT_FRESH_MS;
}

/** The operator's default agent, as the factory last saved it. */
export function factoryDriverName(settings: SettingsReader): string {
  return settings.getSetting(DEFAULT_DRIVER_KEY) ?? "unknown";
}

/** The factory's state as the overview reports it: running, paused, its default agent, and the dashboard served. */
export function factoryState(store: FactoryStateReader): Overview["factory"] {
  const ui = servedDashboard();
  return {
    running: factoryIsRunning(store),
    paused: store.isPaused(),
    driver: factoryDriverName(store),
    factoryOutdated: factoryBuildOutdated(),
    uiOutdated: ui?.outdated ?? false,
    uiBuild: ui?.id ?? null,
    uiCommit: ui?.commit ?? null,
  };
}
