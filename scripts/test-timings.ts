import { relative } from "node:path";
import type { TestEvent } from "node:test/reporters";
import { TEST_GROUPS } from "./test-groups.ts";

/** A second node:test reporter. The native reporter still owns the test output. */
export default async function* testTimings(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const owners = new Map(TEST_GROUPS.flatMap(({ id, suites }) => suites.map((suite) => [suite, id] as const)));
  const groups = new Map<string, { suites: number; durationMs: number }>();
  for await (const event of source) {
    if (event.type !== "test:complete") continue;
    const { file, name, nesting, details } = event.data;
    // Node's outer file test measures the full child process, including startup.
    // Inner tests can overlap or contain subtests, so counting those would double-count time.
    if (!file || name !== file || nesting !== 0 || !Number.isFinite(details.duration_ms)) continue;
    const suite = relative(process.cwd(), file).replaceAll("\\", "/");
    const group = owners.get(suite) ?? "unclassified";
    const timing = groups.get(group) ?? { suites: 0, durationMs: 0 };
    timing.suites++;
    timing.durationMs += details.duration_ms;
    groups.set(group, timing);
  }
  if (!groups.size) {
    yield "Test group timings unavailable (no completed test file timings)\n";
    return;
  }
  yield "Test group timings (sum of completed test file elapsed times):\n";
  for (const [group, timing] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    yield `  ${group}: ${Math.round(timing.durationMs)} ms (files: ${timing.suites})\n`;
  }
}
