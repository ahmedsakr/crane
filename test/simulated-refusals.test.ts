import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, type GuardContext } from "@crane/agent-policy";
import type { Task } from "@crane/contracts";
import { guardRefusals } from "../packages/agent-drivers/src/simulated.ts";

test("simulated driver: wider command access shows each kind of refusal, with the guard's real verdicts", () => {
  const task = { id: "t-1", autonomy: "propose" } as Task;
  const ctx = { task, repo: null, cwd: "/factory/worktrees/t-1", craneHome: "/factory", allowedTools: [] };
  assert.deepEqual(guardRefusals({ ...ctx, commandAccess: "listed" }), []);
  assert.deepEqual(guardRefusals({ ...ctx }), [], "no setting reads as only allowed commands");
  assert.deepEqual(guardRefusals({ ...ctx, task: { ...task, autonomy: "observe" }, commandAccess: "auto" }), [], "investigate-only runs have no guard");
  const most = guardRefusals({ ...ctx, commandAccess: "most" });
  assert.deepEqual(most.map((r) => [r.command, r.refusal?.source, r.guard?.overridable, r.rules]), [
    ["git branch -f main HEAD", "crane.guard", false, []],
    ["npm publish", "crane.guard", true, ["Bash(npm publish:*)"]],
  ]);
  const guard: GuardContext = { access: "most", profile: "worktree", worktree: ctx.cwd, checkout: ctx.cwd, defaultBranch: "main", craneHome: "/factory", home: null, allowed: [] };
  for (const r of most) assert.equal(r.refusal?.reason, classifyToolCall({ tool: "Bash", input: { command: r.command! } }, guard).reason);
  const auto = guardRefusals({ ...ctx, commandAccess: "auto" });
  assert.equal(auto.length, 3);
  assert.equal(auto[2]!.refusal?.source, "claude.auto-mode");
  assert.deepEqual(auto[2]!.rules, ["Bash(npm run db:reset:*)"]);
  assert.equal(auto[2]!.guard, undefined);
});
