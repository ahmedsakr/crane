import { serve as honoServe } from "@hono/node-server";
import pc from "picocolors";
import type { Store } from "../core/store.js";
import { createApp } from "../server/app.js";
import { Factory, factoryIsRunning } from "../factory/orchestrator.js";
import { resolveDriver } from "../factory/drivers.js";
import * as ui from "./ui.js";

export async function serve(store: Store, opts: { port: number; agents: number; driver: string }) {
  if (factoryIsRunning(store)) {
    ui.fail("A factory is already running against this Crane home. Stop it first, or set CRANE_HOME to run another.");
  }
  const driver = await resolveDriver(opts.driver);
  const time = () => ui.dim(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const factory = new Factory(store, driver, { crewSize: opts.agents, log: (l) => console.log(`${time()}  ${l}`) });
  factory.start();

  const app = createApp(store);
  const server = honoServe({ fetch: app.fetch, port: opts.port });

  console.log(`\n${ui.brand()}  ${pc.green("◉")} Factory is running\n`);
  console.log(`  ${ui.dim("Dashboard")}  ${pc.bold(`http://localhost:${opts.port}`)}`);
  console.log(`  ${ui.dim("Agents   ")}  ${opts.agents} on ${driver.label}`);
  if (driver.name === "simulated") {
    console.log(`  ${ui.accent("!")} ${ui.dim("Simulated agents: no model is called. Install Claude Code or pass --driver claude-code.")}`);
  }
  console.log(`\n${ui.hint(['crane do "…"', "in another terminal, to give it work"])}\n`);

  const shutdown = async () => {
    console.log(ui.dim("\nStopping the factory…"));
    await factory.stop();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
