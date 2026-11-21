// The dashboard's HTTP server. The application (`src/cli`) owns listening, TLS and the factory; this package builds
// the request handler and decides whether an address may be served.
export { createApp } from "./app.js";
export type { AppOptions } from "./app.js";
export { checkExposure } from "./security.js";
export type { ExposureCheck, ServeAddress } from "./security.js";
