import { lastMergeOutcome, parseDiff, type DiffFile, type DiffLine, type ParsedDiff } from "@crane/contracts";
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
  const task = store.getTask(id) ?? ui.fail(`No task ${id}`);
  const repo = task.repoId ? store.getRepo(task.repoId) : null;
  if (!repo || !task.branch) ui.fail("This task didn't change any code.");
  const merged = task.status === "merged" ? lastMergeOutcome(store.listEvents(task.id))?.commit : null;
  const { diff, live } = await diffForTask(repo, task, merged);
  if (live) console.log(ui.dim("Changes so far, uncommitted work included. It's still running.\n"));
  if (!diff) return console.log(ui.dim(live ? "No changes yet." : "No changes."));
  const lines = diffLines(task.id, diff, opts);
  if (lines.length) console.log(lines.join("\n"));
}

function diffLines(taskId: string, diff: string, opts: DiffOptions): string[] {
  if (opts.file) return fileLines(taskId, parseDiff(diff).files, opts.file);
  if (opts.files) return fileListLines(taskId, parseDiff(diff));
  return diff.split("\n").map(colorDiffLine);
}

const fileStat = (f: DiffFile) => (f.binary ? ui.dim("binary") : `${pc.green(`+${f.additions}`)} ${pc.red(`-${f.deletions}`)}`);
const fileName = (f: DiffFile) => `${f.oldPath ? `${f.oldPath} → ` : ""}${f.path}${f.status === "modified" ? "" : ui.dim(` (${f.status})`)}`;
const showFile = (taskId: string, f: DiffFile) => `crane diff ${taskId} --file ${/[\s"'$`\\]/.test(f.path) ? JSON.stringify(f.path) : f.path}`;

/** `--files`: each changed file with its line counts, then parser notes. */
function fileListLines(taskId: string, { files, notes }: ParsedDiff): string[] {
  const lines = [...files.map((f) => `${fileStat(f)}  ${fileName(f)}`), ...notes.map((n) => ui.dim(n))];
  if (files[0]) lines.push("\n" + ui.hint([showFile(taskId, files[0]), "see one file's changes"]));
  return lines;
}

/** `--file <path>`: one file's hunks, and a hint to the next file. */
function fileLines(taskId: string, files: DiffFile[], path: string): string[] {
  const f = files.find((x) => x.path === path || x.oldPath === path);
  if (!f) ui.fail(`This task didn't change ${path}. Run crane diff ${taskId} --files to list what it did.`);
  const lines = [`${pc.bold(fileName(f))}  ${fileStat(f)}`];
  if (f.binary) lines.push(ui.dim("A binary file. Its contents aren't shown."));
  else if (!f.hunks.length) lines.push(ui.dim("No line changes."));
  for (const h of f.hunks) lines.push(pc.cyan(h.header), ...h.lines.map((l) => HUNK_LINE[l.kind](l.text)));
  const at = files.indexOf(f);
  const next = files[at + 1];
  if (next) lines.push("\n" + ui.hint([showFile(taskId, next), `next file (${at + 2} of ${files.length})`]));
  return lines;
}

/** One parsed hunk line, with its sign and colour. */
const HUNK_LINE: Record<DiffLine["kind"], (text: string) => string> = {
  add: (text) => pc.green(`+${text}`),
  del: (text) => pc.red(`-${text}`),
  context: (text) => ` ${text}`,
  note: (text) => ui.dim(`\\ ${text}`),
};

/** One line of a raw unified diff, coloured by what it is. */
function colorDiffLine(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return pc.green(line);
  if (line.startsWith("-") && !line.startsWith("---")) return pc.red(line);
  if (line.startsWith("@@")) return pc.cyan(line);
  if (line.startsWith("diff ")) return pc.bold(line);
  return line;
}
