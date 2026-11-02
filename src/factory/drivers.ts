import type { AgentDriver } from "@crane/agent-protocol";
import { ClaudeCodeDriver, CodexDriver, SimulatedDriver } from "@crane/agent-drivers";
import {
  DRIVER_LABEL,
  DRIVER_NAMES,
  EFFORT_LEVELS,
  MODEL_SUGGESTIONS,
  isDriverName,
  type DriverInfo,
  type DriverName,
  type DriverSettings,
} from "@crane/contracts";
import { driverEffortKey, driverModelKey } from "./settings.js";

/**
 * The model and effort an agent runs with. Null leaves it to the agent: its
 * env fallback (`CRANE_MODEL`, `CRANE_CODEX_MODEL`), else its CLI's own config.
 */
export function driverSettings(getSetting: (key: string) => string | null, name: string): DriverSettings {
  return {
    model: getSetting(driverModelKey(name)) || null,
    effort: getSetting(driverEffortKey(name)) || null,
  };
}

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

/**
 * The one place concrete agents are chosen and built. This module is the
 * composition layer, so it's the only one that imports every driver.
 */
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

/** Every agent Crane knows, whether it's installed here, which one is the default, and how each is tuned. */
export async function driverCatalog(
  defaultName: string | null,
  drivers = sharedDrivers(),
  getSetting: (key: string) => string | null = () => null,
): Promise<DriverInfo[]> {
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
          ...driverSettings(getSetting, name),
          efforts: EFFORT_LEVELS[name],
          models: MODEL_SUGGESTIONS[name],
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
  return byName.get("simulated") ?? createDriver("simulated");
}
