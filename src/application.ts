import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFactoryBuildCheck, servedDashboard as selectDashboard,
} from "@crane/backend-runtime";

// This file belongs to the application, in src/ or dist/, never to a workspace dependency.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = import.meta.url.endsWith(".js");

/** Application identity, independent of the location or compilation mode of its dependencies. */
export function factoryRoot(): string {
  return root;
}

/** Capture the loaded application once: rebuilding files cannot update this process. */
export const factoryBuildOutdated = createFactoryBuildCheck(root, compiled);

export function servedDashboard() {
  return selectDashboard(root);
}

