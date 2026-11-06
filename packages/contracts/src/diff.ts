/** Reading git's unified diffs, so the dashboard and the CLI can show a task's changes file by file. */

/** One line of a hunk. `text` has no leading "+", "-" or " ". Notes are git's "\ No newline at end of file". */
export interface DiffLine {
  kind: "context" | "add" | "del" | "note";
  text: string;
  /** Its line number before the change, when it has one. */
  oldLine: number | null;
  /** Its line number after the change, when it has one. */
  newLine: number | null;
}

export interface DiffHunk {
  /** The "@@ -1,3 +1,4 @@ …" line. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Its new name, or its old name for a deletion. */
  path: string;
  /** Its old name, when it was renamed. */
  oldPath: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  /** Git shows no lines for a binary file, only that it changed. */
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
  /** Lines outside any file, like Crane's "5 more new files not shown". */
  notes: string[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** "a/<path> b/<path>": the same path twice unless it was renamed, which later header lines name. */
function headerPath(rest: string): string {
  const n = (rest.length - 5) / 2;
  const same = Number.isInteger(n) && rest.startsWith("a/") && rest.slice(2 + n, n + 5) === " b/" && rest.slice(2, 2 + n) === rest.slice(n + 5);
  return same ? rest.slice(2, 2 + n) : rest;
}

/** Where `parseDiff` is: the file and hunk it is filling, and its place in that hunk. */
interface DiffCursor {
  files: DiffFile[];
  notes: string[];
  file: DiffFile | null;
  hunk: DiffHunk | null;
  /** Lines the current hunk still has to come, on each side. A hunk ends when both run out. */
  oldLeft: number;
  newLeft: number;
  /** The next line's number on each side. */
  oldNo: number;
  newNo: number;
}

/** Splits a unified git diff into files and hunks, numbering each line on both sides. */
export function parseDiff(diff: string): ParsedDiff {
  const at: DiffCursor = { files: [], notes: [], file: null, hunk: null, oldLeft: 0, newLeft: 0, oldNo: 0, newNo: 0 };
  for (const line of diff.split("\n")) readLine(at, line);
  return { files: at.files, notes: at.notes };
}

function readLine(at: DiffCursor, line: string): void {
  if (line.startsWith("diff --git ")) return startFile(at, line);
  if (!at.file) {
    if (line) at.notes.push(line);
    return;
  }
  const m = HUNK.exec(line);
  // Every line inside a hunk starts with "+", "-", " " or "\", so "@@" always starts a new one.
  if (m) return startHunk(at, at.file, line, m);
  if (at.hunk && (at.oldLeft > 0 || at.newLeft > 0)) return readHunkLine(at, at.file, at.hunk, line);
  if (at.hunk) return readAfterHunk(at, at.hunk, line);
  readFileHeader(at.file, line);
}

function startFile(at: DiffCursor, line: string): void {
  at.file = { path: headerPath(line.slice("diff --git ".length)), oldPath: null, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
  at.files.push(at.file);
  at.hunk = null;
  at.oldLeft = at.newLeft = 0;
}

function startHunk(at: DiffCursor, file: DiffFile, line: string, m: RegExpExecArray): void {
  at.oldNo = Number(m[1]);
  at.newNo = Number(m[3]);
  at.oldLeft = m[2] === undefined ? 1 : Number(m[2]);
  at.newLeft = m[4] === undefined ? 1 : Number(m[4]);
  at.hunk = { header: line, lines: [] };
  file.hunks.push(at.hunk);
}

function noteLine(line: string): DiffLine {
  return { kind: "note", text: line.slice(1).trim(), oldLine: null, newLine: null };
}

function readHunkLine(at: DiffCursor, file: DiffFile, hunk: DiffHunk, line: string): void {
  if (line.startsWith("+")) {
    hunk.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: at.newNo++ });
    file.additions++;
    at.newLeft--;
  } else if (line.startsWith("-")) {
    hunk.lines.push({ kind: "del", text: line.slice(1), oldLine: at.oldNo++, newLine: null });
    file.deletions++;
    at.oldLeft--;
  } else if (line.startsWith("\\")) {
    hunk.lines.push(noteLine(line));
  } else {
    // A context line. Git's output may have lost the trailing space of an empty one.
    hunk.lines.push({ kind: "context", text: line.slice(1), oldLine: at.oldNo++, newLine: at.newNo++ });
    at.oldLeft--;
    at.newLeft--;
  }
}

/** Past the hunk's last line: only a note about the line before still belongs to it. */
function readAfterHunk(at: DiffCursor, hunk: DiffHunk, line: string): void {
  if (line.startsWith("\\")) hunk.lines.push(noteLine(line));
  else if (line) at.notes.push(line);
}

/** The file's header, before its first hunk. */
function readFileHeader(file: DiffFile, line: string): void {
  if (line.startsWith("new file mode")) file.status = "added";
  else if (line.startsWith("deleted file mode")) file.status = "deleted";
  else if (line.startsWith("rename from ")) {
    file.status = "renamed";
    file.oldPath = line.slice("rename from ".length);
  } else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
  // Git ends "+++" lines with a tab when the path has a space.
  else if (line.startsWith("+++ b/")) file.path = line.slice(6).replace(/\t$/, "");
  else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
}

/** The files a unified git diff touches, in order, by their new name (or old name, for deletions). */
export function diffFiles(diff: string): string[] {
  return parseDiff(diff).files.map((f) => f.path);
}

/** One row of a before/after view. A side is null where the other side has a line with nothing facing it. */
export interface SplitRow {
  before: DiffLine | null;
  after: DiffLine | null;
}

/**
 * Lays a hunk out side by side: unchanged lines face themselves, and each run of removed
 * lines faces the run of added lines that replaced it, row by row.
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  let last: DiffLine["kind"] | null = null;
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ before: dels[i] ?? null, after: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "del") {
      // Git lists a change's removals before its additions, so a removal after additions starts a new change.
      if (adds.length) flush();
      dels.push(line);
    } else if (line.kind === "add") adds.push(line);
    else if (line.kind === "note") {
      // A note is about the line just before it, so it sits on that line's side.
      if (last === "del") dels.push(line);
      else if (last === "add") adds.push(line);
      else {
        flush();
        rows.push({ before: line, after: line });
      }
      continue;
    } else {
      flush();
      rows.push({ before: line, after: line });
    }
    last = line.kind;
  }
  flush();
  return rows;
}
