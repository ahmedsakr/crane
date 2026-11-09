import { errorMessage } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Store } from "@crane/storage";
import { factoryIsRunning } from "../../factory/state.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { act } from "./shared.js";

/** The operator's review decisions on a task. */
export function registerDecisions(program: Command, ctx: CliContext): void {
  const { actions } = ctx;
  registerVisualReview(program, ctx);
  registerApprove(program, ctx);
  registerMerge(program, ctx);
  registerPreApprove(program, ctx);
  act(program, "decline", "Decline a task and discard its branch", (id, n) => actions.reject(id, n), "Declined");
  act(program, "cancel", "Stop a queued or running task", (id) => actions.cancel(id), "Cancelled");
}

function registerVisualReview(program: Command, { actions }: CliContext): void {
  program
    .command("visual-review")
    .description("Record candidate visual inspection or an explicit waiver (pre-approved tasks waive automatically)")
    .argument("<id>")
    .requiredOption("--commit <sha>", "full candidate commit inspected or waived")
    .requiredOption("-m, --message <note>", "reviewed views, sizes and screenshot paths, or waiver reason and unreviewed scope")
    .option("--waive", "explicitly waive visual review for this candidate")
    .action(async (id: string, opts: { commit: string; message: string; waive?: boolean }) => {
      try {
        const task = await actions.recordVisualReview(id, { status: opts.waive ? "waived" : "inspected", commit: opts.commit, note: opts.message });
        ui.ok(`Visual review ${task.visualReview!.status} for ${task.visualReview!.commit}`);
      } catch (err) { ui.fail(errorMessage(err)); }
    });
}

function registerApprove(program: Command, { store, actions }: CliContext): void {
  program
    .command("approve")
    .description("Approve a task that's waiting for you, and merge and push its branch")
    .argument("<id>")
    .option("-m, --message <note>", "leave a note on the task")
    .option("--no-merge", "approve only: keep the branch for you to merge yourself")
    .action(async (id: string, opts: { message?: string; merge: boolean }) => {
      try {
        const m = await actions.approve(id, opts.message, { merge: opts.merge });
        if (m.status === "merging") mergeQueued(store, m.id);
        else ui.ok(`Approved ${ui.dim(m.id)}${m.branch ? `  ${ui.dim(`branch ${m.branch} is kept`)}` : ""}`);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
}

function registerMerge(program: Command, { store, actions }: CliContext): void {
  program
    .command("merge")
    .description("Merge an approved task's branch into the default branch and push it")
    .argument("<id>")
    .action(async (id: string) => {
      try {
        mergeQueued(store, (await actions.merge(id)).id);
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
}

function registerPreApprove(program: Command, { store, actions }: CliContext): void {
  program
    .command("pre-approve")
    .description("Approve a queued or running task ahead of time and waive visual review, including conflict resolutions")
    .argument("<id>")
    .option("-m, --message <note>", "leave a note on the task")
    .option("--undo", "take the pre-approval back, so it waits for your review")
    .action((id: string, opts: { message?: string; undo?: boolean }) => {
      try {
        if (opts.undo) {
          const m = actions.undoPreApproval(id);
          ui.ok(`Undid pre-approval. It waits for your review  ${ui.dim(m.id)}`);
          return;
        }
        const m = actions.preApprove(id, opts.message);
        const main = (m.repoId && store.getRepo(m.repoId)?.defaultBranch) || "main";
        ui.ok(`Pre-approved. Crane merges it into ${main} after its checks and acceptance pass; visual review is waived, including conflict resolutions  ${ui.dim(m.id)}`);
        console.log(ui.hint([`crane watch ${m.id}`, "follow along live"], [`crane pre-approve ${m.id} --undo`, "wait for review instead"]));
      } catch (err) {
        ui.fail(errorMessage(err));
      }
    });
}

function mergeQueued(store: Store, id: string) {
  const m = store.getTask(id)!;
  const main = (m.repoId && store.getRepo(m.repoId)?.defaultBranch) || "main";
  ui.ok(`Approved. Merging into ${main}  ${ui.dim(m.id)}`);
  if (!factoryIsRunning(store)) console.log(`  ${ui.accent("!")} The factory is off. Run ${pc.bold("crane serve")} to merge it.`);
  else if (store.isPaused()) console.log(`  ${ui.accent("!")} The factory is paused. It merges when you ${pc.bold("crane resume")}.`);
  console.log(ui.hint([`crane watch ${m.id}`, "follow the merge"]));
}
