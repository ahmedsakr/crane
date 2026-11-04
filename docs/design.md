# Crane design language

Crane should feel like a calm brokerage app for software work: you glance at it, see whether anything needs you, and act in one tap. Everything else stays out of the way until you ask for it.

## Principles

1. **Decision first.** Every screen leads with what the operator needs to decide or know. On Home that's the slab and "Needs you". On a task it's the decision bar, then the summary.
2. **Progressive disclosure.** Summaries before findings, findings before files, files before diffs. Tool steps in the timeline fold into "12 steps: …" until opened. The CLI mirrors this: `crane` → `crane show` → `crane show --events` → `crane diff`.
3. **Explain guesses.** When Crane infers something (repo, type, freedom), show the guess *and the reason*, and make it one tap to change.
4. **Safe by default.** New instructions default to "Investigate only" unless the operator clearly asks for a change.
5. **One accent.** Crane yellow is reserved for the slab, "needs you" markers, and the single most important action in a decision moment. Everywhere else is ink on white.

## Tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--concrete` | `#F4F5F3` | `#0F1011` | Page ground |
| `--surface` | `#FFFFFF` | `#17181A` | Cards, sheets |
| `--ink` | `#131416` | `#EDEDEA` | Text, primary buttons |
| `--graphite` | `#6B6F76` | `#8D9097` | Secondary text |
| `--hairline` | `#E6E7E4` | `#26282B` | Dividers, borders |
| `--crane` | `#F2B807` | `#F2B807` | The accent. A fill only, never text on white. |
| `--ok` / `--bad` / `--live` | green / red / blue | | Done / failed / running |

**Type.** Schibsted Grotesk (700) for display: big numbers, page and section titles, tight tracking. Inter for body text and UI. JetBrains Mono for ids, branches, paths, and diffs.

**Shape.** Radii 8 / 14 / 22. Pills for buttons and chips. Soft, low shadows.

## Signature: the slab

The Home hero is a solid crane-yellow slab with a big number (tasks shipped in the range) and an ink line of cumulative output, with agent activity as faint "volume" bars beneath. Scrubbing the chart rewrites the number for that moment, like a stock chart. The slab turns graphite when the factory is paused or off, so its state reads at a glance.

## The site

Below the decisions on Home, "On site" shows the work in motion: a tower crane carries each task, as a crate, between six pads (Queued, Working, Needs you, Merging, Shipped, Didn't ship) as its status changes. It is ambient, not a control. Crates take their colour from their pad (blue for working, yellow only for Needs you, green for shipped, red for didn't ship), a legend names the pads, pointing at a crate shows the task, and tapping opens it. Like the slab, the crane goes graphite when the factory is off. It draws only while something moves, and lands every move at once for reduced motion. The model lives in `web/src/lib/site.ts`; the drawing in `web/src/components/site-view.ts`.

## Goals

A goal's work uses one colour per phase, on its status, task cards, and progress bar: blue for working, yellow for needs you, red for stopped, green for done, and graphite for waiting. Lists group by what the operator does next. Goals group into Needs you, In progress, and Finished; once a goal runs, its tasks group into Needs you, Working now, Up next, and Done. Finished work folds away. A draft plan reads as numbered steps instead, because its order is the decision. The brief steps aside once work starts.

## Sheets

A page row shows who or what, its state, and the one action that matters now. The rest opens in a sheet (`web/src/components/Sheet.tsx`): head and foot pinned, the body scrolling between them, and a bottom sheet on phones. It holds focus while open and returns it to what opened it. Don't expand forms inside a row, and don't stack sheets: a form opened from a sheet replaces its contents and has a back button. Escape and tapping outside step back one view; the close button always leaves.

## Choosing a time

Offer the times people mean before asking for a date. `ScheduleFields` leads with presets (In 1 hour, Tonight, Tomorrow, Monday), then **Pick a time**, already filled in with a sensible default, so no field ever starts blank. A line underneath always says what the choice means ("Tomorrow at 9:00 AM · in 20 hours"), so a wrong date is visible before anything is saved. Forms that create a recurring schedule start ready to save too.

## CLI

Same vocabulary, same hierarchy. `▟ crane` is the mark. Yellow marks what needs you; cyan marks live work; everything else is default or dim. Every screen ends with one to three suggested next commands (`›`).
