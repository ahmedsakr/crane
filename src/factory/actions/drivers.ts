import { driverLabel, type DriverInfo } from "@crane/contracts";
import type { Store } from "../../core/store.js";
import { checkDriver, checkDriverSettings } from "../action-inputs.js";
import { driverCatalog, isAvailable, sharedDrivers } from "../drivers.js";
import { DEFAULT_DRIVER_KEY, driverEffortKey, driverModelKey } from "../settings.js";

/** Every agent Crane can run, whether it's installed, and which is the default. */
export function listDrivers(store: Store): Promise<DriverInfo[]> {
  return driverCatalog(store.getSetting(DEFAULT_DRIVER_KEY), sharedDrivers(), (k) => store.getSetting(k));
}

/**
 * Choose the model and effort one agent runs with. Leave a field out to keep
 * it; null, "" or "default" goes back to the agent's own default. It applies
 * from the next run, including a resumed one.
 */
export async function configureDriver(store: Store, name: string, input: { model?: string | null; effort?: string | null }): Promise<DriverInfo[]> {
  const driver = checkDriver(name);
  if (!driver) throw new Error("Choose which agent to set up");
  const { model, effort } = checkDriverSettings(driver, input);
  // Validate the whole request before changing either saved preference.
  if (model !== undefined) store.setSetting(driverModelKey(driver), model ?? "");
  if (effort !== undefined) store.setSetting(driverEffortKey(driver), effort ?? "");
  return listDrivers(store);
}

/** Choose the agent new tasks run on, unless the operator picks another for a task. */
export async function setDefaultDriver(store: Store, name: string): Promise<DriverInfo[]> {
  const driver = checkDriver(name);
  if (!driver) throw new Error("Choose which agent to use by default");
  const d = sharedDrivers().find((x) => x.name === driver)!;
  if (!(await isAvailable(d, 0))) {
    throw new Error(`${driverLabel(driver)} isn't installed here, so it can't be the default yet`);
  }
  store.setSetting(DEFAULT_DRIVER_KEY, driver);
  return listDrivers(store);
}
