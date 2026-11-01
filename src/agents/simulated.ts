import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../core/git.js";
import type { AgentDriver, RunContext, RunResult } from "../agent-protocol/index.js";
import type { Finding, TaskKind } from "../core/types.js";
import { suggestRules } from "../core/permissions.js";

/**
 * A stand-in driver that walks through a believable sequence of steps without
 * calling any model. Use it to try Crane, demo the UI, or develop offline.
 * Everything it produces is labelled as simulated.
 */
export class SimulatedDriver implements AgentDriver {
  readonly name = "simulated";
  readonly label = "Simulated";
  constructor(private stepMs = Number(process.env.CRANE_SIM_STEP_MS ?? 1400)) {}

  async available() {
    return true;
  }

  async run(ctx: RunContext): Promise<RunResult> {
    if (ctx.job?.kind === "resolve_conflicts") return this.resolve(ctx, ctx.job.files);
    const { task, emit, signal } = ctx;
    const script = SCRIPTS[task.kind];
    let steps = script.steps;
    ctx.onSession?.(`sim-${task.id}`);
    if (ctx.resumeSession) {
      // A real agent keeps its history; this one just skips ahead to the second half.
      emit("note", "Picking up where it left off before the restart.", { simulated: true });
      steps = steps.slice(Math.floor(steps.length / 2));
    }
    for (const [type, message] of steps) {
      await sleep(this.stepMs * (0.6 + Math.random() * 0.8), signal);
      if (type === "blocked") {
        // Shaped like the Claude Code driver's, so the decision flow can be tried offline.
        const rules = suggestRules("Bash", { command: message }, ["Bash(tail:*)", "Bash(head:*)", "Bash(grep:*)"]);
        emit("blocked", `Blocked: ${message}`, { tool: "Bash", command: message, rules, simulated: true });
      } else emit(type, message, { simulated: true });
    }
    await sleep(this.stepMs, signal);
    // When allowed to change code, leave a real (harmless) change so the review and diff flow is exercised.
    if (task.autonomy !== "observe") {
      await mkdir(join(ctx.cwd, ".crane-simulated"), { recursive: true });
      await writeFile(
        join(ctx.cwd, ".crane-simulated", `${task.id}.md`),
        `# ${task.title}\n\nSimulated change. A real agent would edit:\n\n${script.changedFiles.map((f) => `- ${f}`).join("\n")}\n`,
      );
      emit("tool", `Wrote .crane-simulated/${task.id}.md`, { simulated: true });
    }
    return {
      report: {
        summary: `Simulated run. ${script.summary}`,
        findings: script.findings,
        changedFiles: [],
      },
    };
  }

  /** Resolve conflicts by keeping both sides, which is what a cautious human does with append-only files. */
  private async resolve(ctx: RunContext, files: string[]): Promise<RunResult> {
    const { emit, signal, cwd } = ctx;
    emit("note", "Reading both sides of each conflict.", { simulated: true });
    for (const f of files) {
      await sleep(this.stepMs * 0.5, signal);
      const p = join(cwd, f);
      if (!existsSync(p)) continue;
      await writeFile(p, keepBothSides(await readFile(p, "utf8")));
      await git(cwd, "add", "--", f);
      emit("tool", `Edited ${f}`, { simulated: true });
    }
    return {
      report: { summary: `Simulated run. Kept both sides of the conflicts in ${files.length} file(s).`, findings: [], changedFiles: files },
    };
  }
}

/** Drop conflict markers (and any diff3 base section), keeping "ours" then "theirs". */
export function keepBothSides(text: string): string {
  const out: string[] = [];
  let state: "plain" | "ours" | "base" | "theirs" = "plain";
  for (const line of text.split("\n")) {
    if (/^<{7}(\s|$)/.test(line)) state = "ours";
    else if (state === "ours" && /^\|{7}(\s|$)/.test(line)) state = "base";
    else if ((state === "ours" || state === "base") && /^={7}$/.test(line)) state = "theirs";
    else if (state === "theirs" && /^>{7}(\s|$)/.test(line)) state = "plain";
    else if (state !== "base") out.push(line);
  }
  return out.join("\n");
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Cancelled by operator"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Cancelled by operator"));
      },
      { once: true },
    );
  });
}

type Step = ["note" | "tool" | "finding" | "blocked", string];

const SCRIPTS: Record<TaskKind, { steps: Step[]; summary: string; findings: Finding[]; changedFiles: string[] }> = {
  maintenance: {
    steps: [
      ["note", "Starting with the test suite and recent history to see where things break."],
      ["tool", "Ran git log --since=30.days --stat"],
      ["tool", "Searched for “retry”"],
      ["tool", "Read src/http/client.ts"],
      ["note", "The retry helper swallows timeouts, which explains the intermittent failures."],
      ["finding", "Timeouts are retried without backoff"],
      ["tool", "Read package.json"],
      ["blocked", "pnpm audit --prod | tail -20"],
      ["note", "Two dependencies are a major version behind; one has a published advisory."],
      ["finding", "Outdated dependency with a known advisory"],
    ],
    summary: "Found the cause of the flaky requests and one dependency worth upgrading soon.",
    findings: [
      {
        title: "Timeouts are retried without backoff",
        detail: "`retry()` in `src/http/client.ts` retries immediately on timeout, so slow upstreams get hammered. Add exponential backoff with jitter.",
        impact: "high",
        effort: "small",
      },
      {
        title: "Outdated dependency with a known advisory",
        detail: "Upgrade to the next minor. The changelog shows no breaking changes for the APIs this repo uses.",
        impact: "medium",
        effort: "small",
      },
    ],
    changedFiles: ["src/http/client.ts", "package.json"],
  },
  repo_feature: {
    steps: [
      ["note", "Mapping the codebase so the feature lands in the right place."],
      ["tool", "Listed src/**/*.ts"],
      ["tool", "Read src/routes/index.ts"],
      ["tool", "Searched for “export function”"],
      ["note", "The routing layer is the natural seam. There's already a pattern for this."],
      ["tool", "Searched the web for “prior art and common pitfalls”"],
      ["finding", "Fits behind the existing middleware chain"],
      ["note", "Drafting an implementation plan with the smallest first slice."],
      ["finding", "Ship it in two slices"],
    ],
    summary: "The feature fits cleanly behind the existing middleware. Recommend shipping it in two slices.",
    findings: [
      {
        title: "Fits behind the existing middleware chain",
        detail: "Add a new middleware next to `auth()` and reuse the request context. No schema changes needed for slice one.",
        impact: "high",
        effort: "medium",
      },
      {
        title: "Ship it in two slices",
        detail: "Slice one: read-only behaviour behind a flag. Slice two: writes, once the read path has run for a week.",
        impact: "medium",
        effort: "small",
      },
    ],
    changedFiles: ["src/middleware/feature.ts", "src/routes/index.ts"],
  },
  factory_feature: {
    steps: [
      ["note", "Reading how Crane schedules and runs agents today."],
      ["tool", "Read src/factory/orchestrator.ts"],
      ["tool", "Read src/agents/driver.ts"],
      ["note", "Drivers are pluggable, so new capabilities can land without touching the scheduler."],
      ["tool", "Searched for “claimNextTask”"],
      ["finding", "Add task priorities to the queue"],
      ["note", "Checking how the UI would surface it."],
      ["tool", "Read web/src/pages/Overview.tsx"],
      ["finding", "Let the operator reorder the queue"],
    ],
    summary: "Crane would benefit most from task priorities next. The scheduler change is small.",
    findings: [
      {
        title: "Add task priorities to the queue",
        detail: "Add a `priority` column and order `claimNextTask` by priority, then age.",
        impact: "high",
        effort: "small",
      },
      {
        title: "Let the operator reorder the queue",
        detail: "Drag to reorder in the Tasks view, and `crane bump <id>` in the CLI.",
        impact: "medium",
        effort: "medium",
      },
    ],
    changedFiles: ["src/core/store.ts", "web/src/pages/Tasks.tsx"],
  },
};
