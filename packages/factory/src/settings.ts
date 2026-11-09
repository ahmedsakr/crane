/**
 * Setting keys and default limits shared by the factory, its status queries,
 * the server and the CLI. A leaf: it imports nothing, so reading a key or a
 * default never pulls in drivers, merging or the scheduler.
 */

/** The setting that holds the operator's default agent. */
export const DEFAULT_DRIVER_KEY = "factory_driver";

/** The setting a running factory stamps with the time on every tick. "0" once it stops. */
export const HEARTBEAT_KEY = "factory_heartbeat";

/** The settings that hold the model and effort the operator chose for one agent. */
export const driverModelKey = (name: string) => `driver_model:${name}`;
export const driverEffortKey = (name: string) => `driver_effort:${name}`;

/** Most turns one agent run may take, unless CRANE_MAX_TURNS or `--max-turns` says otherwise. */
export const DEFAULT_MAX_TURNS = 200;
/** Most minutes a task may hold a crew slot, unless CRANE_TIME_LIMIT_MIN or `--time-limit` says otherwise. */
export const DEFAULT_TIME_LIMIT_MIN = 90;
