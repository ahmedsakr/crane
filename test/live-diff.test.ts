import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffFiles } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createWorktree, diffForTask, MAX_NEW_FILES } from "../src/factory/git.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
});
