import { errorMessage, driverLabel, goalWaves, type Goal } from "@crane/contracts";
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import pc from "picocolors";
import type { Store } from "../../core/store.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { repoName } from "./shared.js";

type PrintGoal = (goal: Goal, json?: boolean) => void;

/** How the goal's tasks reach the default branch, given what the operator approved. */
function goalMergeLine(goal: Goal): string {
  if (!goal.approvedAt) return "Implementation waits for plan approval.";
  return goal.autoMerge ? "Automatic merging approved, including visual-review waivers." : "Each task waits for review before merge.";
}

function printGoal(store: Store, goal: Goal, json: boolean) {
  if (json) return console.log(JSON.stringify(store.goalDetail(goal.id), null, 2));
  console.log(`\n${pc.bold(goal.title)}\n  ${goal.id} · ${goal.status.replaceAll("_", " ")} · revision ${goal.revision} · ${repoName(store, goal.repoId)}`);
  console.log(`\n${goal.outcome}\n`);
  if (goal.error) console.log(pc.red(goal.error));
  console.log(`Research: crane show ${goal.researchTaskId}`);
  if (goal.plan) {
    console.log(`\n${goal.plan.summary}\n\n${goal.plan.approach}`);
    for (const [i, wave] of goalWaves(goal.plan).entries()) {
      console.log(ui.section(i ? `Then: group ${i + 1}` : "Start together"));
      for (const item of wave) {
        const taskId = goal.tasks.find((t) => t.key === item.key)?.taskId;
        const task = taskId ? store.getTask(taskId) : null;
        console.log(`  ${item.key}: ${item.title}${task ? ` · ${task.id} · ${task.status}` : ""}`);
        // The plan freezes at approval, but the agent can still change, so its task has the current one.
        const run = task ?? item;
        console.log(`    ${run.driver ? driverLabel(run.driver) : "Factory default"} · ${run.model ?? "default model"} · ${run.effort ?? "default"} effort · after ${item.dependsOn.join(", ") || "nothing"}`);
        console.log(`    ${item.rationale}\n\n${item.brief}\n`);
        for (const criterion of item.acceptance) console.log(`    Accept: ${criterion}`);
        for (const command of item.acceptanceChecks ?? []) console.log(`    Check must pass: ${command}`);
      }
    }
    if (goal.plan.improvements.length) console.log(`\nOptional improvements:\n${goal.plan.improvements.map((s) => `- ${s}`).join("\n")}`);
  }
  for (const feedback of goal.feedback) console.log(`\nFeedback (revision ${feedback.revision}): ${feedback.text}\nResearch: ${feedback.taskId}`);
  console.log(`\n${goalMergeLine(goal)}`);
  console.log(ui.hint([`crane goals show ${goal.id} --json`, "full plan and task records"],
    ...(!goal.approvedAt ? [[`crane goals feedback ${goal.id} --revision ${goal.revision} "…"`, "ask the research agent to revise the plan"] as [string, string],
      [`crane goals approve ${goal.id} --revision ${goal.revision}`, "queue the plan; add --auto-merge to pre-approve all tasks and waive visual review"] as [string, string]] : [])));
}

export function registerGoals(program: Command, ctx: CliContext): void {
  const { store } = ctx;
  const goals = program.command("goals").description("Research, review and orchestrate outcomes as dependency-ordered tasks");
  // `crane goals --json show <id>` works too: the flag on the parent applies to every subcommand.
  const print: PrintGoal = (goal, json = false) => void printGoal(store, goal, json || !!goals.opts().json);
  goals.option("--json", "full goal records as JSON").action((opts: { json?: boolean }) => {
    store.syncGoals();
    const list = store.listGoals();
    if (opts.json) console.log(JSON.stringify(list, null, 2));
    else {
      for (const g of list) console.log(`  ${g.id} · ${g.status.replaceAll("_", " ")} · ${g.title}`);
      if (!list.length) console.log("No goals yet. Start one with crane goals create --repo <repo> \"desired outcome\".");
    }
  });
  registerResearch(goals, ctx, print);
  registerPlanDecisions(goals, ctx, print);
}

function registerResearch(goals: Command, { store, actions }: CliContext, printGoal: PrintGoal): void {
  goals.command("create").description("Start read-only research for a desired outcome")
    .argument("<outcome>").requiredOption("-r, --repo <repo>", "connected repo name or id")
    .option("--agent <agent>", "research agent: claude-code | codex | simulated")
    .option("--model <model>", "research model (requires --agent)").option("--effort <effort>", "research effort (requires --agent)")
    .option("--json", "full goal detail as JSON")
    .action((outcome: string, opts: { repo: string; agent?: string; model?: string; effort?: string; json?: boolean }) => {
      try { printGoal(actions.createGoal({ outcome, repoId: opts.repo, driver: opts.agent, model: opts.model, effort: opts.effort }), opts.json); }
      catch (err) { ui.fail(errorMessage(err)); }
    });
  goals.command("show").argument("<id>").option("--json", "full plan, research and task records as JSON")
    .action((id: string, opts: { json?: boolean }) => {
      store.syncGoals();
      printGoal(store.getGoal(id) ?? ui.fail(`No goal ${id}`), opts.json);
    });
  goals.command("feedback").description("Ask the research agent for a revised plan")
    .argument("<id>").argument("<feedback>").requiredOption("--revision <number>", "revision you reviewed")
    .option("--json", "full goal detail as JSON")
    .action((id: string, feedback: string, opts: { revision: string; json?: boolean }) => {
      try { printGoal(actions.reviseGoal(id, Number(opts.revision), feedback), opts.json); }
      catch (err) { ui.fail(errorMessage(err)); }
    });
}

function registerPlanDecisions(goals: Command, { actions }: CliContext, printGoal: PrintGoal): void {
  goals.command("edit").description("Replace the draft plan with a JSON GoalPlan file (use show --json to inspect it)")
    .argument("<id>").requiredOption("--revision <number>", "revision you reviewed").requiredOption("--file <path>", "JSON plan file")
    .option("--json", "full goal detail as JSON")
    .action((id: string, opts: { revision: string; file: string; json?: boolean }) => {
      try { printGoal(actions.editGoalPlan(id, Number(opts.revision), JSON.parse(readFileSync(opts.file, "utf8"))), opts.json); }
      catch (err) { ui.fail(errorMessage(err)); }
    });
  goals.command("approve").description("Approve this exact draft and queue its task graph")
    .argument("<id>").requiredOption("--revision <number>", "revision you reviewed")
    .option("--auto-merge", "pre-approve all tasks, merging after checks/acceptance; waive visual review including conflict resolutions")
    .option("--json", "full goal detail as JSON")
    .action((id: string, opts: { revision: string; autoMerge?: boolean; json?: boolean }) => {
      try { printGoal(actions.approveGoal(id, Number(opts.revision), opts.autoMerge ?? false), opts.json); }
      catch (err) { ui.fail(errorMessage(err)); }
    });
  goals.command("cancel").description("Cancel unmerged goal work; wait for merges in progress first")
    .argument("<id>").requiredOption("--revision <number>", "revision you reviewed").option("--json", "full goal detail as JSON")
    .action((id: string, opts: { revision: string; json?: boolean }) => {
      try { printGoal(actions.cancelGoal(id, Number(opts.revision)), opts.json); }
      catch (err) { ui.fail(errorMessage(err)); }
    });
  goals.command("retry").description("Retry a failed goal task and reconnect its waiting dependents")
    .argument("<id>").argument("<taskId>").requiredOption("--revision <number>", "revision you reviewed").option("--agent <agent>", "retry on another agent")
    .option("--model <model>", "model for the retry, or default").option("--effort <effort>", "model effort for the retry, or default").option("--json", "full goal detail as JSON")
    .action((id: string, taskId: string, opts: { revision: string; agent?: string; model?: string; effort?: string; json?: boolean }) => {
      try { printGoal(actions.retryGoalTask(id, Number(opts.revision), taskId, { driver: opts.agent, model: opts.model, effort: opts.effort }), opts.json); }
      catch (err) { ui.fail(errorMessage(err)); }
    });
  goals.command("change-agent").description("Change who runs one task in a draft plan. Once approved, use crane change-agent on the queued task")
    .argument("<id>").argument("<key>", "the task's key in the plan").requiredOption("--revision <number>", "revision you reviewed")
    .option("--agent <agent>", "run it on another agent").option("--model <model>", "model for this task, or default").option("--effort <effort>", "model effort for this task, or default")
    .option("--json", "full goal detail as JSON")
    .action((id: string, key: string, opts: { revision: string; agent?: string; model?: string; effort?: string; json?: boolean }) => {
      try { printGoal(actions.changeGoalPlanAgent(id, Number(opts.revision), key, { driver: opts.agent, model: opts.model, effort: opts.effort }), opts.json); }
      catch (err) { ui.fail(errorMessage(err)); }
    });
}
