import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testPlan } from "./test-ownership.ts";
import { runTestSuites } from "./test-runner.ts";

export function testArguments(args: readonly string[]): { groups?: string[]; list: boolean } {
  const groups: string[] = [];
  let full = false;
  let list = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--list") list = true;
    else if (arg === "--full") full = true;
    else if (arg === "--group" && args[index + 1] && !args[index + 1]!.startsWith("--")) groups.push(args[++index]!);
    else throw new Error(`Unknown or incomplete argument: ${arg}. Use --full or --group <id>, optionally --list.`);
  }
  if (full && groups.length) throw new Error("--full and --group cannot be combined");
  return { groups: groups.length ? groups : undefined, list };
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const args = testArguments(process.argv.slice(2));
  const plan = testPlan(root, args.groups);
  for (const reason of plan.fallback) console.error(`Full test fallback: ${reason}`);
  if (args.list) console.log(JSON.stringify(plan, null, 2));
  else process.exitCode = await runTestSuites(plan.suites, { cwd: root });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
