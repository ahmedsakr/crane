#!/usr/bin/env node
// Prefer the compiled build; fall back to running the TypeScript source via tsx in a dev checkout.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist", "cli", "index.js");

if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(pathToFileURL(join(root, "src", "cli", "index.ts")).href);
}
