import { serve as honoServe } from "@hono/node-server";
import pc from "picocolors";
import type { Store } from "../core/store.js";
import { createApp, isLoopbackAddress } from "../server/app.js";
import { Factory, factoryIsRunning } from "../factory/orchestrator.js";
import { DEFAULT_DRIVER_KEY, isAvailable, resolveDefaultDriver, sharedDrivers } from "../factory/drivers.js";
import { factoryBuildOutdated, servedDashboard } from "../core/webbuild.js";
import { DEFAULT_HOST } from "../core/paths.js";
import * as ui from "./ui.js";

export async function serve(
  store: Store,
  opts: { port: number; host?: string; agents: number; driver: string; buildDashboard?: boolean; maxTurns?: number; timeLimit?: number },
) {
  if (factoryIsRunning(store)) {
    ui.fail("A factory is already running against this Crane home. Stop it first, or set CRANE_HOME to run another.");
  }
  const drivers = sharedDrivers();
  const driver = await resolveDefaultDriver(opts.driver, store.getSetting(DEFAULT_DRIVER_KEY), drivers).catch(
    (err: Error) => ui.fail(err.message),
  );
  // The default comes first, so the factory keeps it. Tasks can still ask for any of the others.
  store.setSetting(DEFAULT_DRIVER_KEY, driver.name);
  const others = drivers.filter((d) => d !== driver);
  const time = () => ui.dim(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const buildDashboard = opts.buildDashboard ?? true;
  const factory = new Factory(store, [driver, ...others], {
    crewSize: opts.agents,
    maxTurns: opts.maxTurns,
    timeLimitMin: opts.timeLimit,
    log: (l) => console.log(`${time()}  ${l}`),
    buildDashboard,
  });
  factory.start();

  const hostname = opts.host ?? DEFAULT_HOST;
  const exposed = !isLoopbackAddress(hostname);
  const app = createApp(store, { exposed });
  const server = honoServe({ fetch: app.fetch, port: opts.port, hostname });

  console.log(`\n${ui.brand()}  ${pc.green("◉")} Factory is running\n`);
  console.log(`  ${ui.dim("Dashboard")}  ${pc.bold(`http://localhost:${opts.port}`)}`);
  if (exposed) {
    console.log(
      `  ${ui.accent("!")} ${ui.dim(`Listening on ${hostname}. Anyone who can reach it can approve and merge tasks; the dashboard has no login.`)}`,
    );
  }
  console.log(`  ${ui.dim("Agents   ")}  ${store.listAgents().filter((a) => a.active).length} active · factory default ${driver.label}`);
  const installed = (
    await Promise.all(others.filter((d) => d.name !== "simulated").map(async (d) => ((await isAvailable(d)) ? d.label : null)))
  ).filter(Boolean);
  if (installed.length) console.log(`  ${ui.dim("Also      ")}  ${installed.join(", ")}  ${ui.dim("crane agents use <name> to switch")}`);
  const limits = [
    factory.timeLimitMin ? `${factory.timeLimitMin} min` : "no time limit",
    factory.maxTurns ? `${factory.maxTurns} turns` : "no turn limit",
  ];
  console.log(`  ${ui.dim("Limits   ")}  ${limits.join(" · ")} ${ui.dim("per task")}`);
  if (driver.name === "simulated") {
    console.log(
      `  ${ui.accent("!")} ${ui.dim("Simulated agents: no model is called. Install Claude Code or Codex, or pass --driver claude-code or --driver codex.")}`,
    );
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
