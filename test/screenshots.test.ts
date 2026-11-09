import "../src/application.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReport } from "@crane/agent-protocol";
import { resumePrompt, systemPrompt } from "../packages/agent-drivers/src/prompts.js";
import { readScreenshot, retainScreenshots, screenshotPath } from "@crane/storage";
import { Store } from "@crane/storage";
import { Factory } from "@crane/factory/runtime";
import { createApp } from "../src/server/app.js";
import type { AgentDriver } from "@crane/agent-protocol";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "crane-images-"));
  const oldHome = process.env.CRANE_HOME;
  process.env.CRANE_HOME = join(root, "home");
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "view.png"), png);
  t.after(() => {
    if (oldHome === undefined) delete process.env.CRANE_HOME;
    else process.env.CRANE_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, worktree };
}

test("screenshots: reports normalize image entries and preserve older reports", () => {
  const report = parseReport('```crane-report\n' + JSON.stringify({
    summary: "Changed UI", screenshots: [null, {}, "view.png", { path: "view.png", caption: "Phone", url: "https://example.com" },
      { path: "other.png", caption: 42 }, { path: "long.png", caption: "x".repeat(500) }],
  }) + '\n```');
  assert.deepEqual(report.screenshots, [{ path: "view.png", caption: "Phone" }, { path: "long.png", caption: "x".repeat(300) }]);
  assert.equal(parseReport("Older plain text report").screenshots, undefined);
});

test("screenshots: retained images survive worktree removal, restart, and are served only for their task", async t => {
  const { root, worktree } = setup(t);
  const db = join(root, "test.db");
  let store = new Store(db);
  const task = store.createTask({ kind: "repo_feature", title: "UI", brief: "", repoId: null, autonomy: "propose" });
  const other = store.createTask({ kind: "repo_feature", title: "Other UI", brief: "", repoId: null, autonomy: "propose" });
  const notes: string[] = [];
  const screenshots = retainScreenshots(task.id, worktree, [{ path: "view.png", caption: "Desktop" }], m => notes.push(m));
  assert.equal(screenshots.length, 1);
  assert.deepEqual(notes, []);
  store.updateTask(task.id, { report: { summary: "Updated", findings: [], changedFiles: [], screenshots } });
  store.close();
  rmSync(worktree, { recursive: true });
  store = new Store(db);
  try {
    const app = createApp(store);
    const name = screenshots[0]!.path;
    const response = await app.request(`/api/tasks/${task.id}/screenshots/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    // The app-wide frame-ancestors joins the image's own policy rather than replacing it.
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox; frame-ancestors 'none'");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    for (const id of [other.id, "t-missing"]) {
      assert.equal((await app.request(`/api/tasks/${id}/screenshots/${name}`)).status, 404);
    }
    assert.equal((await app.request(`/api/tasks/${task.id}/screenshots/not-an-image.png`)).status, 404);
    assert.equal((await (await app.request(`/api/tasks/${task.id}`)).json()).task.report.screenshots[0].caption, "Desktop");
    rmSync(screenshotPath(task.id, name)!);
    assert.equal((await app.request(`/api/tasks/${task.id}/screenshots/${name}`)).status, 404);
  } finally { store.close(); }
});

test("screenshots: reject outside paths, symlinks outside the worktree, nonimages, directories and oversized files", t => {
  const { root, worktree } = setup(t);
  const external = join(root, "secret.png");
  writeFileSync(external, png);
  symlinkSync(external, join(worktree, "link.png"));
  symlinkSync(root, join(worktree, "linked-dir"));
  writeFileSync(join(worktree, "fake.png"), "<svg onload=alert(1)>");
  writeFileSync(join(worktree, "huge.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  mkdirSync(join(worktree, "dir.png"));
  const paths = [external, "../secret.png", "link.png", "linked-dir/secret.png", "fake.png", "huge.png", "dir.png", "missing.png", ".git/config", "C:\\secret.png", "file\0.png"];
  const notes: string[] = [];
  assert.deepEqual(retainScreenshots("t-test", worktree, paths.map(path => ({ path, caption: "Invalid" })), m => notes.push(m)), []);
  assert.equal(notes.length, paths.length);
  assert.ok(notes.every(m => m.startsWith("Couldn't attach screenshot")));
  assert.equal(screenshotPath("../outside", "x.png"), null);
  assert.equal(readScreenshot("t-test", "../secret.png"), null);
});

test("screenshots: accept raster formats, cap the image count, and reject stored symlink escapes", t => {
  const { root, worktree } = setup(t);
  writeFileSync(join(worktree, "view.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(join(worktree, "view.webp"), Buffer.from("RIFF0000WEBP"));
  const notes: string[] = [];
  const screenshots = retainScreenshots("t-test", worktree,
    Array.from({ length: 14 }, (_, i) => ({ path: ["view.png", "view.jpg", "view.webp"][i % 3]!, caption: "View" })), m => notes.push(m));
  assert.equal(screenshots.length, 12);
  assert.deepEqual(screenshots.slice(0, 3).map(s => readScreenshot("t-test", s.path)?.mime), ["image/png", "image/jpeg", "image/webp"]);
  assert.match(notes[0]!, /first 12 screenshots/);
  const target = screenshotPath("t-test", screenshots[0]!.path)!;
  rmSync(target);
  writeFileSync(join(root, "external.png"), png);
  symlinkSync(join(root, "external.png"), target);
  assert.equal(readScreenshot("t-test", screenshots[0]!.path), null);
});

test("screenshots: UI instructions respect investigate-only and sandbox restrictions", () => {
  const store = new Store(":memory:");
  try {
    for (const autonomy of ["propose", "act", "observe"] as const) {
      const task = store.createTask({ kind: "repo_feature", title: "UI", brief: "", repoId: null, autonomy });
      const prompt = systemPrompt(task, null, undefined, { sandboxed: true });
      if (autonomy === "observe") assert.doesNotMatch(prompt, /If you built or changed UI/);
      else {
        assert.match(prompt, /If you built or changed UI/);
        assert.match(prompt, /never substitute mockups/);
        assert.match(prompt, /do not authorize writes in investigate-only mode or bypassing sandbox restrictions/);
      }
      assert.match(prompt, /Your sandbox has no network/);
    }
    assert.match(resumePrompt(), /If you built or changed UI/);
  } finally { store.close(); }
});

test("screenshots: factory collects a modifying task's attachments before review and ignores observe attachments", async t => {
  const { root, worktree: repoPath } = setup(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repoPath, ".gitignore"), ".crane/\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "Initial");
  const store = new Store(join(root, "factory.db"));
  const repo = store.addRepo({ path: repoPath });
  store.setRepoChecks(repo.id, ["true"]);
  const modifying = store.createTask({ kind: "repo_feature", title: "UI", brief: "", repoId: repo.id, autonomy: "propose" });
  store.updateTask(modifying.id, { report: { summary: "Previous run", findings: [], changedFiles: [], validation: [{
    phase: "review", commit: "previous", command: "true", status: "passed", exitCode: 0, logs: "", durationMs: 0,
  }] } });
  const observe = store.createTask({ kind: "repo_feature", title: "Investigate", brief: "", repoId: repo.id, autonomy: "observe" });
  const driver: AgentDriver = {
    name: "scripted", label: "Scripted", available: async () => true,
    async run(ctx) {
      if (ctx.task.autonomy !== "observe") {
        mkdirSync(join(ctx.cwd, ".crane"));
        writeFileSync(join(ctx.cwd, ".crane", "view.png"), png);
        writeFileSync(join(ctx.cwd, "ui.txt"), "Updated view");
      }
      return { report: { summary: "Done", findings: [], changedFiles: [], completion: { status: "completed", reason: "View updated", evidence: "ui.txt" }, screenshots: [{ path: ".crane/view.png", caption: "View" }] } };
    },
  };
  const factory = new Factory(store, driver, { crewSize: 1, tickMs: 10, buildDashboard: false });
  try {
    factory.start();
    for (let i = 0; i < 500 && ["queued", "running"].includes(store.getTask(observe.id)!.status); i++) {
      await new Promise(res => setTimeout(res, 10));
    }
    await factory.stop();
    assert.equal(store.getTask(modifying.id)!.status, "needs_review", JSON.stringify(store.listEvents(modifying.id)));
    const report = store.getTask(modifying.id)!.report!;
    assert.equal(report.screenshots?.length, 1);
    assert.deepEqual(readScreenshot(modifying.id, report.screenshots![0]!.path)?.bytes, png);
    assert.deepEqual(report.changedFiles, ["ui.txt"]);
    assert.equal(report.validation?.length, 2, "collecting attachments preserves earlier factory validation");
    assert.equal(report.validation?.[0]?.commit, "previous");
    assert.equal(store.getTask(observe.id)!.status, "done");
    assert.deepEqual(store.getTask(observe.id)!.report!.screenshots, []);
  } finally {
    await factory.stop();
    store.close();
  }
});
