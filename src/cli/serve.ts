import { serve as honoServe, type ServerType } from "@hono/node-server";
import pc from "picocolors";
import type { AgentDriver } from "@crane/agent-protocol";
import type { Store } from "../core/store.js";
import { createApp, type AppOptions } from "../server/app.js";
import { checkExposure, type ExposureCheck } from "../server/security.js";
import { Factory } from "../factory/orchestrator.js";
import { factoryIsRunning } from "../factory/state.js";
import { DEFAULT_DRIVER_KEY } from "../factory/settings.js";
import { isAvailable, resolveDefaultDriver, sharedDrivers } from "../factory/drivers.js";
import { factoryBuildOutdated, servedDashboard } from "../core/webbuild.js";
import { DEFAULT_HOST } from "../core/paths.js";
import * as ui from "./ui.js";

/** Take the dashboard's port. A port in use rejects here, rather than as an uncaught `error` event later. */
function listen(options: Parameters<typeof honoServe>[0]): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = honoServe(options, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

export interface ServeOptions {
  port: number;
  host?: string;
  agents: number;
  driver: string;
  buildDashboard?: boolean;
  maxTurns?: number;
  timeLimit?: number;
  /** The origin operators browse to, such as https://crane.example.com. */
  publicUrl?: string;
  /** Honour X-Forwarded-Proto and X-Forwarded-For from a proxy on this machine. */
  trustProxy?: boolean;
  /** Serve an exposed factory without HTTPS, with a warning. */
  allowInsecureHttp?: boolean;
}

/**
 * Whether these address options may serve, failing with the reason if not. Checked before the factory takes any
 * work, since exposed without an operator or HTTPS is never safe. `crane start` also checks before building.
 */
function exposureOrFail(store: Store, opts: ServeOptions): ExposureCheck {
  const check = checkExposure({
    host: opts.host ?? DEFAULT_HOST, publicUrl: opts.publicUrl, allowInsecureHttp: opts.allowInsecureHttp,
    operators: store.access.countOperators(),
  });
  if (check.error) ui.fail(check.error);
  return check;
}

export async function serve(store: Store, opts: ServeOptions) {
  if (factoryIsRunning(store)) {
    ui.fail("A factory is already running against this Crane home. Stop it first, or set CRANE_HOME to run another.");
  }
  const exposure = exposureOrFail(store, opts);
  if (exposure.warning) console.log(`${ui.accent("!")} ${exposure.warning}`);
  const drivers = sharedDrivers();
  const driver = await resolveDefaultDriver(opts.driver, store.getSetting(DEFAULT_DRIVER_KEY), drivers).catch(
    (err: Error) => ui.fail(err.message),
  );
  // The default comes first, so the factory keeps it. Tasks can still ask for any of the others.
  store.setSetting(DEFAULT_DRIVER_KEY, driver.name);
  const others = drivers.filter((d) => d !== driver);
  const time = () => ui.dim(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const log = (line: string) => console.log(`${time()}  ${line}`);
  const buildDashboard = opts.buildDashboard ?? true;

  // Before the factory starts: without its port it would claim tasks, then die under them.
  const hostname = opts.host ?? DEFAULT_HOST;
  const { exposed, publicUrl } = exposure;
  const app = { exposed, publicUrl: publicUrl?.origin, trustProxy: opts.trustProxy };
  const server = await listenOrFail(store, { port: opts.port, hostname, log, app });
  saveServeAddress(store, exposure);

  const factory = new Factory(store, [driver, ...others], {
    crewSize: opts.agents,
    maxTurns: opts.maxTurns,
    timeLimitMin: opts.timeLimit,
    log,
    buildDashboard,
  });
  factory.start();

  await printBanner({ store, factory, driver, others, port: opts.port, hostname, exposure, buildDashboard });
  handleShutdown(store, factory, server);
}

/** Save the address for CLI links after listening succeeds; clear any old address when serving without one. */
export function saveServeAddress(store: Store, exposure: ExposureCheck): void {
  store.setPublicUrl(exposure.publicUrl?.origin ?? null);
}

type Address = { port: number; hostname: string; log: (line: string) => void; app: AppOptions };

async function listenOrFail(store: Store, address: Address): Promise<ServerType> {
  const { port, hostname, log } = address;
  const app = createApp(store, { ...address.app, log });
  return listen({ fetch: app.fetch, port, hostname }).catch((err: NodeJS.ErrnoException) =>
    ui.fail(
      err.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Stop what's using it, or choose another with --port.`
        : `Couldn't listen on ${hostname}:${port}: ${err.message}`,
    ),
  );
}

interface Banner {
  store: Store;
  factory: Factory;
  driver: AgentDriver;
  others: AgentDriver[];
  port: number;
  hostname: string;
  exposure: ExposureCheck;
  buildDashboard: boolean;
}

/** Where operators browse to, where Crane listens when that differs, and whether they must sign in. */
function printAccess(store: Store, port: number, hostname: string, { exposed, publicUrl }: ExposureCheck) {
  console.log(`  ${ui.dim("Dashboard")}  ${pc.bold(publicUrl?.origin ?? `http://localhost:${port}`)}`);
  if (exposed) console.log(`  ${ui.dim("Listening")}  ${hostname}:${port}`);
  const operators = store.access.countOperators();
  if (operators > 0) {
    console.log(`  ${ui.dim("Sign-in  ")}  on · ${operators} ${operators === 1 ? "operator" : "operators"}`);
    return;
  }
  console.log(`  ${ui.dim("Sign-in  ")}  off on this machine until an operator exists  ${ui.dim("crane operators add <username> --admin")}`);
}

async function printBanner({ store, factory, driver, others, port, hostname, exposure, buildDashboard }: Banner) {
  console.log(`\n${ui.brand()}  ${pc.green("◉")} Factory is running\n`);
  printAccess(store, port, hostname, exposure);
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
    console.log(`  ${ui.accent("!")} ${ui.dim("The dashboard is older than its source. Run npm run build -w web to see the latest UI.")}`);
  }
  console.log(`\n${ui.hint(['crane do "…"', "in another terminal, to give it work"])}\n`);
}

function handleShutdown(store: Store, factory: Factory, server: ServerType) {
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
