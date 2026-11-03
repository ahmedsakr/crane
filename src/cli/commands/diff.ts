import { lastMergeOutcome, parseDiff, type DiffFile } from "@crane/contracts";
import type { Command } from "commander";
import pc from "picocolors";
import { diffForTask } from "../../factory/git.js";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";

interface DiffOptions {
  files?: boolean;
  file?: string;
}

export function registerDiff(program: Command, ctx: CliContext): void {
  program
    .command("diff")
    .description("Show the changes a task made on its branch, or has made so far while it runs")
    .argument("<id>")
    .option("--files", "list the changed files with lines added and removed")
    .option("--file <path>", "show the changes to one file")
    .action((id: string, opts: DiffOptions) => showDiff(ctx, id, opts));
}

async function showDiff({ store }: CliContext, id: string, opts: DiffOptions): Promise<void> {
  const m = store.getTask(id) ?? ui.fail(`No task ${id}`);
  const repo = m.repoId ? store.getRepo(m.repoId) : null;
  if (!repo || !m.branch) ui.fail("This task didn't change any code.");
  const merged = m.status === "merged" ? lastMergeOutcome(store.listEvents(m.id))?.commit : null;
  const { diff, live } = await diffForTask(repo, m, merged);
  if (live) console.log(ui.dim("Changes so far, uncommitted work included. It's still running.\n"));
  if (!diff) return console.log(ui.dim(live ? "No changes yet." : "No changes."));
  if (opts.files || opts.file) {
    const { files, notes } = parseDiff(diff);
    const stat = (f: DiffFile) => (f.binary ? ui.dim("binary") : `${pc.green(`+${f.additions}`)} ${pc.red(`-${f.deletions}`)}`);
    const name = (f: DiffFile) => `${f.oldPath ? `${f.oldPath} → ` : ""}${f.path}${f.status === "modified" ? "" : ui.dim(` (${f.status})`)}`;
    const show = (f: DiffFile) => `crane diff ${m.id} --file ${/[\s"'$`\\]/.test(f.path) ? JSON.stringify(f.path) : f.path}`;
    if (!opts.file) {
      for (const f of files) console.log(`${stat(f)}  ${name(f)}`);
      for (const n of notes) console.log(ui.dim(n));
      if (files[0]) console.log("\n" + ui.hint([show(files[0]), "see one file's changes"]));
      return;
    }
    const f = files.find((x) => x.path === opts.file || x.oldPath === opts.file);
    if (!f) ui.fail(`This task didn't change ${opts.file}. Run crane diff ${m.id} --files to list what it did.`);
    console.log(`${pc.bold(name(f))}  ${stat(f)}`);
    if (f.binary || !f.hunks.length) console.log(ui.dim(f.binary ? "A binary file. Its contents aren't shown." : "No line changes."));
    for (const h of f.hunks) {
      console.log(pc.cyan(h.header));
      for (const l of h.lines) {
        const sign = { add: "+", del: "-", context: " ", note: "\\ " }[l.kind];
        const text = sign + l.text;
        console.log(l.kind === "add" ? pc.green(text) : l.kind === "del" ? pc.red(text) : l.kind === "note" ? ui.dim(text) : text);
      }
    }
    const at = files.indexOf(f);
    const next = files[at + 1];
    if (next) console.log("\n" + ui.hint([show(next), `next file (${at + 2} of ${files.length})`]));
    return;
  }
  for (const line of diff.split("\n")) {
    console.log(
      line.startsWith("+") && !line.startsWith("+++")
        ? pc.green(line)
        : line.startsWith("-") && !line.startsWith("---")
          ? pc.red(line)
          : line.startsWith("@@")
            ? pc.cyan(line)
            : line.startsWith("diff ")
              ? pc.bold(line)
              : line,
    );
  }
}
