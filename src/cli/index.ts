import { Store } from "../core/store.js";
import { runCli } from "./program.js";

await runCli(process.argv, new Store());
