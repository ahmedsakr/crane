/** How the changes viewer presents a parsed diff, and the layout preference it remembers. */
import type { DiffFile, DiffLine } from "@crane/contracts";

export type DiffLayout = "inline" | "split";

const LAYOUT_KEY = "crane.diffLayout";
const STATUS: Record<DiffFile["status"], string | null> = { added: "New", deleted: "Deleted", renamed: "Moved", modified: null };
const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", context: " ", note: "" };

export function savedDiffLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "inline";
  } catch {
    return "inline";
  }
}

export function saveDiffLayout(layout: DiffLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Private windows may refuse; the choice still holds for this page.
  }
}

/** Which file is open. A live diff can drop the open file; fall back to the first. */
export function openFileIndex(files: Pick<DiffFile, "path">[], selected: string | null): number {
  return Math.max(0, files.findIndex((file) => file.path === selected));
}

export function fileStatusLabel(file: Pick<DiffFile, "status">): string | null {
  return STATUS[file.status];
}

export function filePathLabel(file: Pick<DiffFile, "path" | "oldPath">): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

/** Why a file shows no lines, or null when it has lines to show. */
export function noLinesNote(file: Pick<DiffFile, "binary" | "hunks" | "status">): string | null {
  if (file.binary) return "A binary file. Its contents aren't shown.";
  if (file.hunks.length) return null;
  return file.status === "renamed" ? "Moved, with its contents unchanged." : "No line changes.";
}

/** Line numbers get one width per file, so every row's gutter lines up. */
export function gutterWidth(file: Pick<DiffFile, "hunks">): string {
  const widest = Math.max(...file.hunks.flatMap((h) => h.lines.map((l) => Math.max(l.oldLine ?? 0, l.newLine ?? 0))));
  return `${Math.max(2, String(widest).length)}ch`;
}

export function inlineLineText(line: Pick<DiffLine, "kind" | "text">): string {
  return line.kind === "note" ? line.text : `${SIGN[line.kind]}${line.text}`;
}
