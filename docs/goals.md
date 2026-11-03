# Goals

A goal describes an outcome for one connected repository. Crane runs a read-only
research task to discover the work, supporting refactoring, acceptance criteria,
dependencies, and suitable Claude Code / Codex model and effort choices. Research
uses the existing driver sandbox, crew limits, cancellation, session recovery and
cost ledger. It cannot start implementation.

Open **Goals → New goal**, choose the repo, and describe the outcome. A completed
plan appears in **Needs you** on Home and in Goals. Review the approach and
repository evidence, parallel groups, briefs, acceptance criteria and assignment
rationale. Optional improvements remain suggestions unless included in a task.
**Give feedback** runs fresh research with the previous plan and feedback history;
repeat until satisfied. **Edit plan** lets you change tasks, dependencies, agents,
models, effort and criteria directly. Invalid graphs, unknown agents, unsupported
efforts and incomplete tasks cannot be saved or approved.

**Approve plan** queues the entire graph atomically. Approval targets the revision
you reviewed; an older tab cannot approve a newer plan or create duplicate tasks.
The plan freezes after approval. With two active general crew members, two
independent tasks can run at once, on different agents. Dedicated maintenance and
on-call crew retain their existing pickup rules. Every dependency waits for its
predecessor to **merge**, ensuring its changes are available in the next task's
worktree. Groups illustrate the dependency graph; each task becomes eligible as
soon as its own dependencies land, without waiting for an unrelated group member.

By default, completed tasks wait for individual review and merge approval.
Selecting **Merge goal tasks automatically** pre-approves every generated task,
including its visual-review waiver and conflict resolutions. Crane still enforces
configured checks, completion evidence and acceptance criteria. A plan task can
name repo checks in `acceptanceChecks`, which only Crane's own passing result on
that task's candidate meets; approval rejects a command that isn't one of the
repo's checks. Unfinished work,
failed checks, unavailable agents and failed merges need operator attention;
approval does not bypass these gates. Models left at default follow that agent's
settings at execution. Research proposes settings; it cannot guarantee that every
model is accessible to the operator's account.

A goal completes only after all its current task branches merge. A failed,
cancelled or declined task marks it **Needs attention** and holds dependent work;
independent work can continue. **Retry task**, or **Retry on …**, creates a new
attempt and reconnects queued dependents to it, retaining the approved merge
policy. Switching agents clears the previous agent's model and effort overrides.
Retry through the goal, rather than the ordinary task retry, to preserve the graph.
Existing task review, pre-approval reversal, merge and prerequisite-waiver actions
remain available for explicit operator decisions. **Cancel goal** cancels unmerged
work and preserves merged changes; a merge in progress must finish first.

Plans, feedback, task links, approval policy and versions live in SQLite. A factory
restart reconciles recorded research results and task outcomes rather than
replanning or queuing the graph again. Prior research reports remain accessible
through the feedback history. The simulated research agent returns an explicitly
labelled demo graph, without claiming repository analysis.

## CLI

The CLI uses the same operator actions and version checks as the dashboard:

```sh
crane goals create --repo storefront --agent codex --effort high "Customers can save and reopen carts"
crane goals
crane goals show g-xxxxxx
crane goals show g-xxxxxx --json
crane goals feedback g-xxxxxx --revision 2 "Keep checkout unchanged; include accessibility coverage"
crane goals edit g-xxxxxx --revision 4 --file plan.json
crane goals approve g-xxxxxx --revision 5
crane goals approve g-yyyyyy --revision 2 --auto-merge
crane goals retry g-xxxxxx t-xxxxxx --revision 7 --agent claude-code
crane goals cancel g-xxxxxx --revision 8
```

Use the current revision from `show`, rather than copying these example numbers.
`show --json` returns `{ goal, research, tasks }`; the edit file contains just
`goal.plan`. Every mutation also supports `--json`. `--auto-merge` is the explicit
pre-approval and visual-review waiver; omit it to review each task before merging.

## Candidate visual review

Capture is deferred in Codex's restricted sandbox because local servers and
Chromium cannot run. In an approved environment, build the candidate branch and
use the existing screenshot tool. The demo seed includes a ready goal with two
parallel tasks so these views are reproducible. All demo assignments use simulated
agents, including after approval. This sequence captures Home's goal
decision, the Goals list, creation, the plan, task editing, feedback, approval,
execution progress and the task backlink. Each invocation starts fresh demo data;
the approval leaves automatic merging unchecked. Use the commands below from the
candidate checkout (the build must succeed before any capture starts):

```sh
npm run build -w web &&
for size in 1280x800 1280x600 390x844; do
  npm run screenshot -- / --size "$size" \
    --wait-for '.review-row a[href^="/goals/"]' \
    --shot ".crane/screenshots/goals-home-$size.png" \
    --click '.nav a[href="/goals"]' --wait-for '.goal-list-item' \
    --shot ".crane/screenshots/goals-list-$size.png" \
    --click '.page-head .btn' --wait-for '[role="dialog"]' \
    --shot ".crane/screenshots/goals-create-$size.png" --key Escape \
    --click '.goal-list-item' --wait-for '[data-goal-action="approve"]' \
    --shot ".crane/screenshots/goals-plan-$size.png" \
    --click '[data-goal-action="edit"]' --wait-for '.goal-editor-task' \
    --click '.goal-editor-task summary' \
    --shot ".crane/screenshots/goals-edit-$size.png" --key Escape \
    --click '[data-goal-action="feedback"]' --wait-for '[role="dialog"]' \
    --shot ".crane/screenshots/goals-feedback-$size.png" --key Escape \
    --click '[data-goal-action="approve"]' --wait-for '.goal-check' \
    --shot ".crane/screenshots/goals-approve-$size.png" \
    --click '.sheet-pane-foot button' --wait-for '.goal-task a' \
    --shot ".crane/screenshots/goals-progress-$size.png" \
    --click '.goal-task a' --wait-for '.detail-title' \
    --out ".crane/screenshots/goals-task-$size.png"
done
```

Open and inspect every image at wide (1280 × 800), short (1280 × 600), and phone
(390 × 844) sizes for clipping, overflow, readable dependency and agent settings,
sheet scrolling, pinned actions, navigation badges and task backlinks. Exercise
saving a plan, submitting feedback and receiving a new research revision, stale
approval errors, automatic-merge opt-in, and failed-task retry/cancellation in a
scratch goal. Real Claude/Codex research and a complete multi-agent delivery still
need validation with installed, authenticated CLIs outside the sandbox.

Before approval or merge, record the candidate commit, reviewed views and sizes,
and screenshot paths in the task's approval note or review record. Alternatively,
the operator may record an explicit waiver with its reason and unreviewed scope.
An agent cannot grant that waiver or mark inspection complete. Crane retains up
to 12 images attached to a task; select representative images for attachments if
needed and keep the complete inspection record with the approval.
