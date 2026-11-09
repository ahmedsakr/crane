import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindApplication } from "@crane/backend-runtime";

// This file belongs to the application, in src/ or dist/, never to a workspace dependency.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = import.meta.url.endsWith(".js");
bindApplication(root, compiled);

export { factoryRoot, factoryBuildOutdated, servedApplicationDashboard as servedDashboard } from "@crane/backend-runtime";

