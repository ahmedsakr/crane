import { serve as honoServe } from "@hono/node-server";
import pc from "picocolors";
import type { Store } from "../core/store.js";
import { createApp } from "../server/app.js";
import { Factory, factoryIsRunning } from "../factory/orchestrator.js";
import { resolveDriver } from "../factory/drivers.js";
import { factoryBuildOutdated, servedDashboard } from "../core/webbuild.js";
import * as ui from "./ui.js";

export async function serve(
  store: Store,
  opts: { port: number; agents: number; driver: string; buildDashboard?: boolean; maxTurns?: number; timeLimit?: number },
) {
  if (factoryIsRunning(store)) {
    ui.fail("A factory is already running against this Crane home. Stop it first, or set CRANE_HOME to run another.");
  }
  const driver = await resolveDriver(opts.driver);
  const time = () => ui.dim(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const buildDashboard = opts.buildDashboard ?? true;
  const factory = new Factory(store, driver, {
    crewSize: opts.agents,
    maxTurns: opts.maxTurns,
    timeLimitMin: opts.timeLimit,
    log: (l) => console.log(`${time()}  ${l}`),
    buildDashboard,
  });
  factory.start();

  const app = createApp(store);
  const server = honoServe({ fetch: app.fetch, port: opts.port });

  console.log(`\n${ui.brand()}  ${pc.green("◉")} Factory is running\n`);
  console.log(`  ${ui.dim("Dashboard")}  ${pc.bold(`http://localhost:${opts.port}`)}`);
  console.log(`  ${ui.dim("Agents   ")}  ${opts.agents} on ${driver.label}`);
  const limits = [
    factory.timeLimitMin ? `${factory.timeLimitMin} min` : "no time limit",
    factory.maxTurns ? `${factory.maxTurns} turns` : "no turn limit",
  ];
  console.log(`  ${ui.dim("Limits   ")}  ${limits.join(" · ")} ${ui.dim("per task")}`);
  if (driver.name === "simulated") {
    console.log(`  ${ui.accent("!")} ${ui.dim("Simulated agents: no model is called. Install Claude Code or pass --driver claude-code.")}`);
  }
  if (factoryBuildOutdated()) {
    console.log(`  ${ui.accent("!")} ${ui.dim("This is an old build of Crane. Run npm run build, then restart, to run the latest code.")}`);
  } else if (!buildDashboard && servedDashboard()?.outdated) {
    console.log(`  ${ui.accent("!")} ${ui.dim("The dashboard is older than its source. Run npm run build to see the latest UI.")}`);
  }
  console.log(`\n${ui.hint(['crane do "…"', "in another terminal, to give it work"])}\n`);

  let stopping = false;
  const shutdown = async () => {
    // A second Ctrl-C exits at once. The next factory still requeues whatever was running.
    if (stopping) process.exit(130);
    stopping = true;
    const working = store.listTasks({ status: ["running"] }).length;
    console.log(ui.dim("\nStopping the factory…"));
    if (working) {
      const tasks = working === 1 ? "1 running task picks up where it" : `${working} running tasks pick up where they`;
      console.log(ui.dim(`  ${tasks} left off when the factory starts again.`));
    }
    await factory.stop();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
