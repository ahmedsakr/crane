# Recurring crew maintenance

Open a member on Crew, give them a maintenance role, then choose **Add
schedule**. It starts ready to save: weekday mornings in your timezone, on a
repo they don't already cover. Change the repo, days, or time as needed, and
the form shows when the next run would be. **Pre-approve each run** allows runs
that can change code to enter the merge queue after their checks pass;
investigate-only roles cannot be pre-approved. Editing or removing a schedule
affects future runs; use the task page to undo an existing run's pre-approval.

The CLI exposes the same controls:

```sh
crane agents configure jib --role tests
crane agents schedule add jib --repo crane --days 1,2,3,4,5 --time 09:00 --timezone America/Toronto --pre-approve
crane agents schedule list jib --json
crane agents schedule update jib <schedule-id> --time 10:00 --no-pre-approve
crane agents schedule pause jib <schedule-id>
crane agents schedule resume jib <schedule-id>
crane agents schedule remove jib <schedule-id>
```

Days are numbered Sunday (0) through Saturday (6). The factory catches up once
after downtime, then computes the next future slot. On-call or paused members,
a paused factory, and members with a queued, running, review-waiting, or merging
run skip the slot and record the reason. Open runs on other repos also count
for recurring schedules. Manual runs still allow another repo and support a
one-time future start through the member's maintenance run form.
Changing or resuming a schedule starts from its next future slot. Spring clock
gaps skip that day; repeated autumn times use the earlier instant once.

Each firing advances the slot with a conditional update inside a SQLite write
transaction. Task creation, pre-approval, and outcome recording share that
transaction, so another process cannot fire the same slot and a crash cannot
leave the slot advanced without its task or skip outcome. The task retains the
schedule id and its original description even after the schedule is removed.
Schedules belonging to retired crew identities are removed when startup prunes
those members; task provenance is retained.

# Visual review handoff

Capture was deferred in the no-network agent sandbox, which cannot run local
servers or Chromium. Complete this checklist in an approved environment before
approval or merge; typecheck and unit tests do not provide visual validation.

1. Build the candidate branch, seed a disposable demo, and serve it in one terminal:

   ```sh
   npm run build
   CRANE_HOME=/tmp/crane-crew-review node --import tsx scripts/seed-demo.ts
   CRANE_HOME=/tmp/crane-crew-review node --import tsx src/cli/index.ts serve --driver simulated --no-build-dashboard --port 4472
   ```

2. In another terminal configure a role and schedule, then capture each viewport:

   ```sh
   CRANE_HOME=/tmp/crane-crew-review node --import tsx src/cli/index.ts agents configure jib --role tests
   CRANE_HOME=/tmp/crane-crew-review node --import tsx src/cli/index.ts agents schedule add jib --repo payments-api --days 1,2,3,4,5 --time 09:00 --timezone America/Toronto --pre-approve
   npm run screenshot -- /crew --url http://127.0.0.1:4472 --size 1280x800 --wait-for '.crew-row' --click '[aria-label="Jib: open details"]' --wait-for '.schedule-item' --out .crane/screenshots/crew-wide.png
   npm run screenshot -- /crew --url http://127.0.0.1:4472 --size 1280x600 --wait-for '.crew-row' --click '[aria-label="Jib: open details"]' --wait-for '.schedule-item' --out .crane/screenshots/crew-short.png
   npm run screenshot -- /crew --url http://127.0.0.1:4472 --size 390x844 --wait-for '.crew-row' --click '[aria-label="Jib: open details"]' --wait-for '.schedule-item' --out .crane/screenshots/crew-phone.png
   ```

   Use another unused temporary directory if that demo path already exists.
   On `/crew`, inspect the next-run line on the row, the member sheet's schedule
   list, Edit, the day presets and day pills, time/timezone fields, pre-approval
   on/off, validation errors, Save/Cancel, Pause/Resume, and Remove. Capture the
   open edit form too, adding `--click '.schedule-item button'` before `--out` in
   each command above and using `crew-edit-wide.png`, `crew-edit-short.png`,
   `crew-edit-phone.png`.
   Verify paused and last-outcome text. Choose a near-future schedule slot in
   the editor and wait for its run (ensure Jib has no open assigned run); inspect
   the task's origin and pre-approval. Capture `/tasks/<actual-task-id>` with:

   ```sh
   npm run screenshot -- /tasks/<actual-task-id> --url http://127.0.0.1:4472 --size 1280x800 --out .crane/screenshots/scheduled-task-wide.png
   npm run screenshot -- /tasks/<actual-task-id> --url http://127.0.0.1:4472 --size 1280x600 --out .crane/screenshots/scheduled-task-short.png
   npm run screenshot -- /tasks/<actual-task-id> --url http://127.0.0.1:4472 --size 390x844 --out .crane/screenshots/scheduled-task-phone.png
   ```

   Also capture the manual maintenance run form alongside the recurring controls:

   ```sh
   npm run screenshot -- /crew --url http://127.0.0.1:4472 --size 1280x800 --click '[aria-label="Start maintenance run for Jib"]' --out .crane/screenshots/crew-run-wide.png
   npm run screenshot -- /crew --url http://127.0.0.1:4472 --size 1280x600 --click '[aria-label="Start maintenance run for Jib"]' --out .crane/screenshots/crew-run-short.png
   npm run screenshot -- /crew --url http://127.0.0.1:4472 --size 390x844 --click '[aria-label="Start maintenance run for Jib"]' --out .crane/screenshots/crew-run-phone.png
   ```

   Verify repository selection, one-time future start, same-repo duplicate
   warnings, Cancel, and switching between the run form and member settings.
   Confirm the recurring schedule summary and editor still work independently.

3. Open and inspect all resulting images for clipping, overflow, layout, and
   changed behavior at wide 1280×800, short 1280×600, and phone 390×844 sizes.
   Record the candidate commit, reviewed views/states/sizes and screenshot paths
   in the task approval note or review record. Alternatively, the operator may
   record an explicit waiver with its reason and unreviewed scope; the agent
   cannot grant that waiver or mark visual review complete.
