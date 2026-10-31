import type { AgentDriver } from "../agents/driver.js";
import { ClaudeCodeDriver } from "../agents/claude-code.js";
import { CodexDriver } from "../agents/codex.js";
import { SimulatedDriver } from "../agents/simulated.js";
import { DRIVER_LABEL, DRIVER_NAMES, isDriverName, type DriverInfo, type DriverName } from "../core/types.js";

/** The setting that holds the operator's default agent. */
export const DEFAULT_DRIVER_KEY = "factory_driver";

/** Real agents, in the order `auto` tries them. Simulated is the fallback, never picked over a real one. */
const AUTO_ORDER: DriverName[] = ["claude-code", "codex"];

const HINT: Record<DriverName, { ok: string; missing: string }> = {
  "claude-code": {
    ok: "Anthropic's coding agent, using your local claude login",
    missing: "Not installed. Install Claude Code, then run claude to log in",
  },
  codex: {
    ok: "OpenAI's coding agent, using your local codex login",
    missing: "Not installed. Run npm i -g @openai/codex, then codex login",
  },
  simulated: {
    ok: "Calls no model. Walks through believable steps, for trying Crane out",
    missing: "",
  },
};

export function createDriver(name: DriverName): AgentDriver {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeDriver();
    case "codex":
      return new CodexDriver();
    case "simulated":
      return new SimulatedDriver();
  }
}

export function allDrivers(): AgentDriver[] {
  return DRIVER_NAMES.map(createDriver);
}

/**
 * Whether a driver can run here. Checking spawns its CLI, so answers are kept
 * for a little while: the dashboard asks every time it opens a picker.
 */
const checked = new WeakMap<AgentDriver, { at: number; ok: Promise<boolean> }>();
export function isAvailable(driver: AgentDriver, maxAgeMs = 30_000): Promise<boolean> {
  const hit = checked.get(driver);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.ok;
  const ok = driver.available().catch(() => false);
  checked.set(driver, { at: Date.now(), ok });
  return ok;
}

/** Shared by every request in this process, so the cache above does its job. */
let shared: AgentDriver[] | null = null;
export const sharedDrivers = () => (shared ??= allDrivers());

/** Every agent Crane knows, whether it's installed here, and which one is the default. */
export async function driverCatalog(defaultName: string | null, drivers = sharedDrivers()): Promise<DriverInfo[]> {
  return Promise.all(
    drivers
      .filter((d) => isDriverName(d.name))
      .map(async (d) => {
        const name = d.name as DriverName;
        const available = await isAvailable(d);
        return {
          name,
          label: DRIVER_LABEL[name],
          available,
          hint: available ? HINT[name].ok : HINT[name].missing,
          isDefault: name === defaultName,
        };
      }),
  );
}

/**
 * The agent new tasks run on when the factory starts. An explicit preference
 * (`crane serve --driver codex`) wins. `auto` keeps the operator's saved
 * choice if it's a real agent that's installed, else takes the first real
 * agent that is, else falls back to simulated.
 */
export async function resolveDefaultDriver(
  preference: string,
  saved: string | null,
  drivers: AgentDriver[] = sharedDrivers(),
): Promise<AgentDriver> {
  const byName = new Map(drivers.map((d) => [d.name, d]));
  if (preference !== "auto") {
    const d = byName.get(preference);
    if (!d) throw new Error(`Unknown agent “${preference}”. Use one of: auto, ${DRIVER_NAMES.join(", ")}`);
    return d;
  }
  // A saved real agent sticks. Simulated doesn't: a demo run shouldn't leave the factory off real agents.
  const savedDriver = saved && saved !== "simulated" ? byName.get(saved) : undefined;
  if (savedDriver && (await isAvailable(savedDriver))) return savedDriver;
  for (const name of AUTO_ORDER) {
    const d = byName.get(name);
    if (d && (await isAvailable(d))) return d;
  }
  return byName.get("simulated") ?? new SimulatedDriver();
}
