import type { AgentDriver } from "../agents/driver.js";
import { ClaudeCodeDriver } from "../agents/claude-code.js";
import { SimulatedDriver } from "../agents/simulated.js";

/**
 * Pick the agent driver. CRANE_DRIVER can be `claude-code`, `simulated`, or
 * `auto` (the default): use Claude Code when the `claude` CLI is installed.
 */
export async function resolveDriver(preference = process.env.CRANE_DRIVER ?? "auto"): Promise<AgentDriver> {
  if (preference === "simulated") return new SimulatedDriver();
  const claude = new ClaudeCodeDriver();
  if (preference === "claude-code") return claude;
  return (await claude.available()) ? claude : new SimulatedDriver();
}
