import { DRIVER_NAMES, errorMessage } from "@crane/contracts";
import type { Command } from "commander";
import { DEFAULT_HOST, DEFAULT_PORT } from "@crane/backend-runtime";
import { DEFAULT_MAX_TURNS, DEFAULT_TIME_LIMIT_MIN } from "@crane/factory/settings";
import { factoryIsRunning } from "@crane/factory/state";
import { checkExposure } from "../../server/security.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { loadTls, type TlsOptions } from "../tls.js";

interface ServeOptions extends TlsOptions {
  port: string;
  host: string;
  agents: string;
  driver: string;
  buildDashboard: boolean;
  maxTurns?: string;
  timeLimit?: string;
  publicUrl?: string;
  trustProxy?: boolean;
  allowInsecureHttp?: boolean;
}

/** `serve` and `start` load their modules on demand, so every other command stays free of the factory runtime. */
export function registerServe(program: Command, ctx: CliContext): void {
  for (const command of ["serve", "start"] as const) {
    program
      .command(command)
      .description(command === "start" ? "Build and run the factory, rebuilding and restarting when checkout HEAD changes" : "Start the factory: agents, API, and dashboard")
      .option("-p, --port <port>", "port for the dashboard", String(DEFAULT_PORT))
      .option(
        "--host <address>",
        "address to listen on. Any other than loopback needs an operator (crane operators add) and an https --public-url",
        DEFAULT_HOST,
      )
      .option("--public-url <url>", "the https address operators browse to, such as https://crane.example.com behind a reverse proxy")
      .option("--trust-proxy", "trust X-Forwarded-Proto and X-Forwarded-For from a proxy on this machine")
      .option("--tls-cert <file>", "PEM certificate chain for serving HTTPS directly (requires --tls-key)")
      .option("--tls-key <file>", "PEM private key for serving HTTPS directly (requires --tls-cert)")
      .option("--allow-insecure-http", "serve an exposed dashboard without HTTPS, on a network you trust")
      .option("--agents <n>", "initial active crew size (saved member settings take priority)", process.env.CRANE_AGENTS ?? "2")
      .option(
        "--driver <driver>",
        `default agent: auto | ${DRIVER_NAMES.join(" | ")}. auto keeps the one you chose with crane agents use`,
        process.env.CRANE_DRIVER ?? "auto",
      )
      .option("--no-build-dashboard", "don't build the dashboard from merged changes to Crane; serve web/dist as it is")
      .option("--max-turns <n>", `most turns one agent run may take, 0 for no limit (default ${DEFAULT_MAX_TURNS})`)
      .option("--time-limit <minutes>", `most minutes a task may run, 0 for no limit (default ${DEFAULT_TIME_LIMIT_MIN})`)
      .action((opts: ServeOptions) => runFactory(ctx, command, opts));
  }
}

const num = (v: string | undefined, flag: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) ui.fail(`${flag} takes a number, 0 or more`);
  return n;
};

async function runFactory({ store, actions }: CliContext, command: "serve" | "start", opts: ServeOptions): Promise<void> {
  const settings = {
    port: num(opts.port, "--port")!,
    host: opts.host,
    // A bad size would otherwise save every crew member as on-call.
    agents: num(opts.agents, "--agents")!,
    driver: opts.driver,
    buildDashboard: opts.buildDashboard,
    maxTurns: num(opts.maxTurns, "--max-turns"),
    timeLimit: num(opts.timeLimit, "--time-limit"),
    publicUrl: opts.publicUrl,
    trustProxy: opts.trustProxy,
    allowInsecureHttp: opts.allowInsecureHttp,
    tlsCert: opts.tlsCert,
    tlsKey: opts.tlsKey,
  };
  if (command === "start") {
    try { loadTls(settings); } catch (error) { ui.fail(errorMessage(error)); }
    if (factoryIsRunning(store)) ui.fail("A factory is already running against this Crane home. Stop it first, or set CRANE_HOME to run another.");
    // Fail before building rather than after: the supervised serve would refuse these options anyway.
    const exposure = checkExposure({ ...settings, operators: actions.listOperators().length });
    if (exposure.error) ui.fail(exposure.error);
    store.close(); // Only the supervised serve process owns the database while running.
    const { start } = await import("../start.js");
    try {
      process.exitCode = await start(settings);
    } catch (error) {
      ui.fail(`Couldn't start Crane: ${errorMessage(error)}`);
    }
  } else {
    const { serve } = await import("../serve.js");
    await serve(store, settings);
  }
}
