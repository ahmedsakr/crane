# Scheduled tasks: pending visual review

Capture is deferred in the agent sandbox, where local servers and browsers are unavailable. Complete this checklist in an approved environment using the candidate branch before approving or merging it.

- [ ] Record the candidate commit and run `npm run build -w web`.
- [ ] Run the capture recipe below. It uses the repository's existing screenshot tool and disposable demo factory, creating a task through the real UI. It captures the creation sheet (`/?instruct=…`), its new task page (`/tasks/<created-id>`) with **Change start time** expanded, the task list (`/tasks`), and Crew (`/crew`) at 1280x800, 1280x600, and 390x844. These commands are a handoff recipe, not evidence of completed capture.
- [ ] Open every image. Inspect the date input, timezone hint, action buttons, sheet scrolling, scheduled task metadata, task summary, and Crew capacity notice for clipping, overflow, layout, and correct behavior at every size. On short/phone screens, scroll to controls below the fold and capture additional states if necessary.
- [ ] Interactively check switching **Now** / **Later**, blank/past-time errors (including Cmd/Ctrl+Enter), rescheduling and saving, **Start now** with an unmet prerequisite (it must remain held), cancellation, and the transition from scheduled to due while paused and after resuming. Check that future tasks alone do not prompt activation of more crew; the demo may have unrelated queued tasks that legitimately show that prompt.
- [ ] Record the candidate commit, inspected routes/states, sizes, screenshot paths, and results in the task approval note or review record. Alternatively, the operator must explicitly record a waiver with its reason and unreviewed scope. The agent has not completed or waived visual review.

Run from the candidate checkout. The native input setters below send normal input/change events so React receives the chosen start time. Each viewport gets its own disposable demo and a time one day ahead; no production task data is used.

```bash
npm run build -w web
for size in 1280x800 1280x600 390x844; do
  npm run screenshot -- '/?instruct=Investigate%20tests%20in%20payments-api' \
    --size "$size" \
    --wait-for '.understood' \
    --eval "Array.from(document.querySelectorAll('details.gates')).find(d => d.querySelector('summary').textContent.startsWith('Start time')).open = true" \
    --eval "(() => { const s = document.querySelector('.schedule-fields select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'later'); s.dispatchEvent(new Event('change', { bubbles: true })); })()" \
    --wait-for 'input[type=datetime-local]' \
    --eval "(() => { const i = document.querySelector('input[type=datetime-local]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, new Date(Date.now() + 86400000).toISOString().slice(0, 16)); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()" \
    --shot ".crane/screenshots/schedule-create-$size.png" \
    --click '.sheet-foot button[type=submit]' \
    --wait-for '.detail time[datetime]' \
    --click 'article details.gates summary' \
    --shot ".crane/screenshots/schedule-detail-$size.png" \
    --click 'a.back' \
    --wait-for '.rows .row' \
    --shot ".crane/screenshots/schedule-list-$size.png" \
    --click 'nav a[href="/crew"]' \
    --wait-for '.crew-summary' \
    --out ".crane/screenshots/schedule-crew-$size.png"
done
```

The recipe produces twelve images. Keep the paths in the operator's review record; capture alone does not count as inspection.
