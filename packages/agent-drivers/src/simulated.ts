import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentDriver, RunContext, RunResult } from "@crane/agent-protocol";
import type { BlockedCall, Finding, TaskKind } from "@crane/contracts";
import { classifyToolCall, suggestRules, type GuardContext } from "@crane/agent-policy";

const run = promisify(execFile);

/** Stage only a resolved file in the simulated driver's worktree. */
async function stageFile(cwd: string, file: string): Promise<void> {
  await run("git", ["add", "--", file], { cwd, maxBuffer: 16 * 1024 * 1024 });
}

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
    if (ctx.job?.kind === "fix_checks") return this.lookAtFailedChecks(ctx, ctx.job.failures.map((f) => f.command));
    if (ctx.task.autonomy === "observe" && ctx.task.brief.startsWith("Crane goal research\n")) {
      ctx.emit("note", "Simulating goal research; no repository analysis or implementation has occurred.", { simulated: true });
      await sleep(this.stepMs, ctx.signal);
      return { report: { summary: "Simulated goal plan, for trying the workflow only.", findings: [], changedFiles: [],
        completion: { status: "completed", reason: "Simulated planning complete", evidence: "Demo plan generated; no research performed" },
        goalPlan: { summary: "Simulated delivery plan. Replace these demo tasks before real work.",
          approach: "A demo refactoring task precedes two independent tasks; integration waits for both. No repository analysis was performed.",
          improvements: ["Use a real research agent to identify repository-specific improvements."],
          tasks: [
            { key: "foundation", title: "Simulated foundation refactoring", dependsOn: [] },
            { key: "feature", title: "Simulated feature implementation", dependsOn: ["foundation"] },
            { key: "support", title: "Simulated supporting work", dependsOn: ["foundation"] },
            { key: "integration", title: "Simulated integration", dependsOn: ["feature", "support"] },
          ].map((t) => ({ ...t, brief: "This is a simulated task for demonstrating goal orchestration. Write only a simulated note.",
            driver: "simulated", model: null, effort: null, rationale: "Simulated agent chosen for a demo, with no model or effort.", acceptance: ["Simulated note written"] })) } } };
    }
    const { task, emit, signal } = ctx;
    const script = SCRIPTS[task.kind];
    let steps = script.steps;
    ctx.onSession?.(`sim-${task.id}`);
    if (ctx.resumeSession) {
      // A real agent keeps its history; this one just skips ahead to the second half.
      emit("note", "Picking up where it left off before the restart.", { simulated: true });
      steps = steps.slice(Math.floor(steps.length / 2));
    }
    const note = join(ctx.cwd, ".crane-simulated", `${task.id}.md`);
    for (const [i, [type, message]] of steps.entries()) {
      await sleep(this.stepMs * (0.6 + Math.random() * 0.8), signal);
      // Halfway, leave uncommitted work behind, so following changes as they happen can be tried offline.
      if (task.autonomy !== "observe" && i === Math.floor(steps.length / 2)) {
        await mkdir(dirname(note), { recursive: true });
        await writeFile(note, `# ${task.title}\n\nSimulated change, in progress.\n`);
        emit("tool", `Wrote .crane-simulated/${task.id}.md`, { simulated: true });
      }
      if (type === "blocked") emitAllowlistRefusal(ctx, message);
      else emit(type, message, { simulated: true });
    }
    await this.emitGuardRefusals(ctx);
    await sleep(this.stepMs, signal);
    // When allowed to change code, leave a real (harmless) change so the review and diff flow is exercised.
    if (task.autonomy !== "observe") {
      await mkdir(dirname(note), { recursive: true });
      await writeFile(
        note,
        `# ${task.title}\n\nSimulated change. A real agent would edit:\n\n${script.changedFiles.map((f) => `- ${f}`).join("\n")}\n`,
      );
      emit("tool", `Wrote .crane-simulated/${task.id}.md`, { simulated: true });
    }
    return {
      report: {
        summary: `Simulated run. ${script.summary}`,
        findings: script.findings,
        changedFiles: [],
        visualReview: { required: false, reason: "The simulated driver only writes a Markdown note, with no UI changes." },
        completion: { status: "completed", reason: "Simulated task delivered", evidence: "Markdown note written" },
      },
    };
  }

  private async emitGuardRefusals(ctx: RunContext) {
    for (const refusal of guardRefusals(ctx)) {
      await sleep(this.stepMs * 0.5, ctx.signal);
      ctx.emit("blocked", `Blocked: ${refusal.command}`, { ...refusal, simulated: true });
    }
  }

  /** A simulated agent can't fix real code, so it changes nothing and Crane hands the merge back. */
  private async lookAtFailedChecks(ctx: RunContext, commands: string[]): Promise<RunResult> {
    ctx.emit("note", `Reading why ${commands.join(", ")} failed on the merge.`, { simulated: true });
    await sleep(this.stepMs, ctx.signal);
    return {
      report: { summary: "Simulated run. Looked at the failed merge checks and changed nothing, so the merge goes back to the operator.", findings: [], changedFiles: [],
        completion: { status: "blocked", reason: "A simulated agent can't fix real check failures", evidence: "No files changed" },
        visualReview: { required: false, reason: "Nothing was changed." } },
    };
  }

  /** Resolve conflicts by keeping both sides, which is what a cautious human does with append-only files. */
  private async resolve(ctx: RunContext, files: string[]): Promise<RunResult> {
    const { emit, signal, cwd } = ctx;
    emit("note", "Reading both sides of each conflict.", { simulated: true });
    for (const f of ctx.job?.kind === "resolve_conflicts" && ctx.job.phase === "validate" ? [] : files) {
      await sleep(this.stepMs * 0.5, signal);
      const p = join(cwd, f);
      if (!existsSync(p)) continue;
      await writeFile(p, keepBothSides(await readFile(p, "utf8")));
      await stageFile(cwd, f);
      emit("tool", `Edited ${f}`, { simulated: true });
    }
    return {
      report: { summary: `Simulated run. Kept both sides of the conflicts in ${files.length} file(s).`, findings: [], changedFiles: files,
        visualReview: { required: false, reason: "Simulated conflict resolution preserves both sides of text files." } },
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

/** Shaped like the Claude Code driver's allowlist refusal, so the decision flow can be tried offline. */
function emitAllowlistRefusal(ctx: RunContext, command: string) {
  const rules = suggestRules("Bash", { command }, ["Bash(tail:*)", "Bash(head:*)", "Bash(grep:*)"]);
  ctx.emit("blocked", `Blocked: ${command}`, { tool: "Bash", command, rules, simulated: true });
}

/** What a simulated agent tries in "Most commands" repos: one call the guard refuses for good, one the operator can allow. */
const GUARDED_COMMANDS = ["git branch -f main HEAD", "npm publish"];
/** And what auto mode's classifier refuses after the guard lets it through. */
const AUTO_MODE_REFUSAL = { command: "npm run db:reset", reason: "Simulated: resetting the shared database goes beyond what the task asked for." };

/**
 * Guard and auto-mode refusals shaped like the Claude Code driver's, so each
 * kind can be seen offline. The guard's verdicts are real; auto mode's is made up.
 * Investigate-only runs have no guard, like the real driver.
 */
export function guardRefusals(ctx: Pick<RunContext, "task" | "repo" | "cwd" | "commandAccess" | "craneHome" | "allowedTools">): BlockedCall[] {
  const access = ctx.commandAccess ?? "listed";
  if (access === "listed" || ctx.task.autonomy === "observe") return [];
  const guard: GuardContext = {
    access, profile: "worktree", worktree: ctx.cwd, checkout: ctx.repo?.path ?? ctx.cwd,
    defaultBranch: ctx.repo?.defaultBranch ?? "main", craneHome: ctx.craneHome ?? "", home: null, allowed: ctx.allowedTools ?? [],
  };
  const refusals: BlockedCall[] = [];
  for (const [i, command] of GUARDED_COMMANDS.entries()) {
    const verdict = classifyToolCall({ tool: "Bash", input: { command } }, guard);
    if (verdict.decision !== "deny") continue;
    refusals.push({
      tool: "Bash", command, toolUseId: `sim-guard-${i}`, refusal: { source: "crane.guard", reason: verdict.reason },
      guard: { category: verdict.category ?? "guard-error", overridable: verdict.overridable }, rules: verdict.rules,
    });
  }
  if (access === "auto") {
    const { command, reason } = AUTO_MODE_REFUSAL;
    refusals.push({ tool: "Bash", command, toolUseId: "sim-auto-mode", refusal: { source: "claude.auto-mode", reason },
      rules: suggestRules("Bash", { command }, guard.allowed) });
  }
  return refusals;
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
      ["tool", "Read packages/agent-protocol/src/driver.ts"],
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
