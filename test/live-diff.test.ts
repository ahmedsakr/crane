import { test } from "node:test";
import assert from "node:assert/strict";
import { sh } from "./support/git.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffFiles, parseDiff, splitRows } from "@crane/contracts";
import { Store } from "@crane/storage";
import { OperatorActions } from "../src/factory/actions.js";
import { createWorktree, diffForTask, MAX_NEW_FILES } from "../src/factory/git.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-live-diff-"));
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  writeFileSync(join(checkout, "old.txt"), "going away\n");
  writeFileSync(join(checkout, ".gitignore"), "build/\n");
  sh(checkout, "add", ".");
  sh(checkout, "commit", "-q", "-m", "start");
  const store = new Store(join(root, "crane.db"));
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "live-diff");
  const t = actions.createTask({ kind: "maintenance", title: "Work in progress", brief: "", repoId: repo.id, autonomy: "propose" });
  const wt = await createWorktree(repo, t);
  store.updateTask(t.id, { branch: wt.branch, worktree: wt.path });
  store.setStatus(t.id, "running", "Running");
  return { store, repo, checkout, id: t.id, wt: wt.path };
}

test("live diff: a running task shows its commits, uncommitted edits and new files, but not ignored ones", async () => {
  const { store, repo, checkout, id, wt } = await setup();
  try {
    writeFileSync(join(wt, "committed.txt"), "first\n");
    sh(wt, "add", "committed.txt");
    sh(wt, "commit", "-q", "-m", "step one");
    writeFileSync(join(wt, "README.md"), "hi\nedited\n");
    rmSync(join(wt, "old.txt"));
    writeFileSync(join(wt, "staged.txt"), "staged\n");
    sh(wt, "add", "staged.txt");
    mkdirSync(join(wt, "src"));
    writeFileSync(join(wt, "src", "new file.ts"), "export const x = 1;\n");
    mkdirSync(join(wt, "build"));
    writeFileSync(join(wt, "build", "out.js"), "ignored\n");
    const mainBefore = sh(checkout, "rev-parse", "main");

    const { diff, live } = await diffForTask(repo, store.getTask(id)!);
    assert.equal(live, true);
    assert.deepEqual(diffFiles(diff).sort(), ["README.md", "committed.txt", "old.txt", "src/new file.ts", "staged.txt"]);
    assert.match(diff, /\+edited/);
    assert.match(diff, /\+export const x = 1;/);
    assert.match(diff, /-going away/);
    const status = Object.fromEntries(parseDiff(diff).files.map((f) => [f.path, [f.status, f.additions, f.deletions]]));
    assert.deepEqual(status["src/new file.ts"], ["added", 1, 0]);
    assert.deepEqual(status["old.txt"], ["deleted", 0, 1]);
    assert.deepEqual(status["README.md"], ["modified", 1, 0]);

    assert.equal(sh(wt, "status", "--porcelain", "--", "src"), "?? src/", "the new file is still untracked");
    assert.ok(!existsSync(join(sh(wt, "rev-parse", "--absolute-git-dir"), "index.lock")));
    assert.equal(sh(checkout, "rev-parse", "main"), mainBefore);
    assert.equal(sh(checkout, "status", "--porcelain"), "", "the operator's checkout is untouched");

    // Once it stops running, the branch is what counts: uncommitted work isn't part of it.
    store.setStatus(id, "needs_review", "Ready for your review");
    const after = await diffForTask(repo, store.getTask(id)!);
    assert.equal(after.live, false);
    assert.deepEqual(diffFiles(after.diff), ["committed.txt"]);
  } finally {
    store.close();
  }
});

test("live diff: a flood of new files is capped", async () => {
  const { store, repo, id, wt } = await setup();
  try {
    mkdirSync(join(wt, "gen"));
    for (let i = 0; i < MAX_NEW_FILES + 5; i++) writeFileSync(join(wt, "gen", `f${i}.txt`), `${i}\n`);
    const { diff, live } = await diffForTask(repo, store.getTask(id)!);
    assert.equal(live, true);
    assert.equal(diffFiles(diff).length, MAX_NEW_FILES);
    assert.match(diff, /5 more new files not shown$/);
    assert.deepEqual(parseDiff(diff).notes, ["5 more new files not shown"]);
  } finally {
    store.close();
  }
});

test("live diff: a record pointing outside Crane's worktrees never reads the operator's checkout", async () => {
  const { store, repo, checkout, id } = await setup();
  try {
    writeFileSync(join(checkout, "mine.txt"), "operator's work\n");
    store.updateTask(id, { worktree: checkout });
    const { diff, live } = await diffForTask(repo, store.getTask(id)!);
    assert.equal(live, false);
    assert.equal(diff, "", "only the branch, which has nothing yet");
  } finally {
    store.close();
  }
});

test("diffFiles names renamed, deleted and binary files once each", () => {
  const diff = [
    "diff --git a/a.txt b/b.txt",
    "similarity index 100%",
    "rename from a.txt",
    "rename to b.txt",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "Binary files /dev/null and b/img.png differ",
    "diff --git a/x.md b/x.md",
    "--- a/x.md",
    "+++ b/x.md",
    "@@ -1 +1,2 @@",
    " keep",
    "+++ b/not-a-file",
  ].join("\n");
  assert.deepEqual(diffFiles(diff), ["b.txt", "gone.txt", "img.png", "x.md"]);
  assert.deepEqual(diffFiles(""), []);

  const files = parseDiff(diff).files;
  assert.deepEqual(files.map((f) => [f.path, f.oldPath, f.status, f.binary, f.additions, f.deletions]), [
    ["b.txt", "a.txt", "renamed", false, 0, 0],
    ["gone.txt", null, "deleted", false, 0, 1],
    ["img.png", null, "added", true, 0, 0],
    ["x.md", null, "modified", false, 1, 0],
  ]);
  // A hunk's own "+++" line is content, not a header.
  assert.deepEqual(files[3]!.hunks[0]!.lines.map((l) => [l.kind, l.text]), [["context", "keep"], ["add", "++ b/not-a-file"]]);
});

test("parseDiff numbers lines on both sides and keeps trailing notes apart from the last file", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,5 @@ function main() {",
    " one",
    "-two",
    "-three",
    "+TWO",
    "+THREE",
    "+FOUR",
    " ",
    "@@ -40 +41 @@",
    "-last",
    "\\ No newline at end of file",
    "+last",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "3 more new files not shown",
  ].join("\n");
  const { files, notes } = parseDiff(diff);
  assert.deepEqual(notes, ["3 more new files not shown"]);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.hunks.length]), [
    ["src/app.ts", "modified", 4, 3, 2],
    ["new.txt", "added", 1, 0, 1],
  ]);
  const [first, second] = files[0]!.hunks;
  assert.equal(first!.header, "@@ -10,4 +10,5 @@ function main() {");
  assert.deepEqual(first!.lines.map((l) => [l.kind, l.oldLine, l.newLine]), [
    ["context", 10, 10],
    ["del", 11, null],
    ["del", 12, null],
    ["add", null, 11],
    ["add", null, 12],
    ["add", null, 13],
    ["context", 13, 14],
  ]);
  assert.deepEqual(second!.lines.map((l) => [l.kind, l.text, l.oldLine, l.newLine]), [
    ["del", "last", 40, null],
    ["note", "No newline at end of file", null, null],
    ["add", "last", null, 41],
  ]);
  assert.deepEqual(files[1]!.hunks[0]!.lines.map((l) => l.newLine), [1]);

  // Side by side: removals face the additions that replaced them; notes stay on their line's side.
  const side = (rows: ReturnType<typeof splitRows>) => rows.map((r) => [r.before?.text ?? null, r.after?.text ?? null]);
  assert.deepEqual(side(splitRows(first!)), [
    ["one", "one"],
    ["two", "TWO"],
    ["three", "THREE"],
    [null, "FOUR"],
    ["", ""],
  ]);
  assert.deepEqual(side(splitRows(second!)), [
    ["last", "last"],
    ["No newline at end of file", null],
  ]);
});

test("splitRows starts a new pair when a removal follows additions", () => {
  const line = (kind: "add" | "del", text: string) => ({ kind, text, oldLine: null, newLine: null });
  const rows = splitRows({ header: "@@", lines: [line("del", "a"), line("add", "A"), line("del", "b")] });
  assert.deepEqual(rows.map((r) => [r.before?.text ?? null, r.after?.text ?? null]), [["a", "A"], ["b", null]]);
});
