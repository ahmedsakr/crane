import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysLabel,
  localStartTime,
  newScheduleInput,
  nextSchedule,
  parseStartTime,
  schedulePreview,
  startPresets,
  startProblem,
  startSummary,
  timeOfDayLabel,
  tomorrowMorning,
  untilLabel,
  whenLabel,
} from "../web/src/lib/schedule.js";

const NOW = new Date("2030-06-15T12:00:00.000Z");
const DUE = "2030-06-15T13:00:00.000Z";

/** The browser's timezone, as the date helpers see it. */
function inToronto(run: () => void) {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Toronto";
  try {
    run();
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
}

test("scheduling: browser dates use the local timezone and reject empty, past and nonexistent times", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2029-01-01T00:00:00Z") });
  inToronto(() => {
    assert.equal(localStartTime(DUE), "2030-06-15T09:00");
    assert.equal(parseStartTime("2030-06-15T09:00"), DUE);
    assert.equal(parseStartTime(null), null);
    // The last two are what clearing the separate date or time field leaves behind.
    for (const value of ["", "invalid", "2030-02-30T09:00", "2030-03-10T02:30", "2028-06-15T09:00", "T09:00", "2030-06-15T"]) {
      assert.throws(() => parseStartTime(value), /Choose a/, value);
      assert.match(startProblem(value)!, /Choose a/, value);
    }
    assert.equal(startProblem(null), null);
    assert.equal(startProblem("2030-06-15T09:00"), null);
  });
});

test("scheduling: start presets offer the next sensible times and leave out what's past or repeated", () => {
  inToronto(() => {
    const presets = (local: string) => startPresets(new Date(local), "en-US");
    const ids = (local: string) => presets(local).map((p) => p.id);

    // A Monday afternoon: everything's ahead, and "Monday" means next week's.
    const monday = presets("2030-06-17T14:10");
    assert.deepEqual(monday.map((p) => [p.id, p.value]), [
      ["hour", "2030-06-17T15:15"],
      ["tonight", "2030-06-17T21:00"],
      ["tomorrow", "2030-06-18T09:00"],
      ["monday", "2030-06-24T09:00"],
    ]);
    assert.match(monday[1]!.label, /^Tonight 9\sPM$/);
    assert.match(monday[2]!.label, /^Tomorrow 9\sAM$/);

    assert.deepEqual(ids("2030-06-19T20:30"), ["hour", "tomorrow", "monday"], "too late for tonight");
    assert.deepEqual(ids("2030-06-19T06:05"), ["hour", "morning", "tomorrow", "monday"], "this morning is still ahead");
    assert.equal(presets("2030-06-19T06:05")[1]!.value, "2030-06-19T09:00");
    assert.deepEqual(ids("2030-06-16T21:30"), ["hour", "tomorrow"], "from Sunday, Monday is tomorrow");
    assert.equal(presets("2030-06-22T14:00").at(-1)!.value, "2030-06-24T09:00", "from Saturday, Monday is two days off");
    assert.equal(tomorrowMorning(new Date("2030-06-30T23:00")), "2030-07-01T09:00", "crosses the month");
  });
});

test("scheduling: every start preset parses as a future time, even across a clock change", (t) => {
  inToronto(() => {
    // 01:50 the night clocks jump: an hour on is 03:50, and 02:xx doesn't exist.
    for (const local of ["2030-03-10T01:50", "2030-11-03T00:50", "2030-06-17T14:10", "2030-12-31T23:59"]) {
      const now = new Date(local);
      t.mock.timers.enable({ apis: ["Date"], now });
      for (const p of startPresets(now)) assert.ok(parseStartTime(p.value), `${local} ${p.id}`);
      t.mock.timers.reset();
    }
    assert.equal(startPresets(new Date("2030-03-10T01:50"))[0]!.value, "2030-03-10T04:00");
  });
});

test("scheduling: start times read in plain words on the operator's wall clock", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  inToronto(() => {
    const now = NOW.getTime();
    const label = (iso: string, timeZone?: string) => whenLabel(Date.parse(iso), { now, locale: "en-US", timeZone });
    assert.match(label("2030-06-15T22:00:00Z"), /^Today at 6:00\sPM$/);
    assert.match(label("2030-06-16T13:00:00Z"), /^Tomorrow at 9:00\sAM$/);
    assert.match(label("2030-06-24T13:00:00Z"), /^Mon, Jun 24 at 9:00\sAM$/);
    // The same instant is this evening in Toronto and tomorrow morning in Tokyo.
    assert.match(label("2030-06-15T23:30:00Z"), /^Today at 7:30\sPM$/);
    assert.match(label("2030-06-15T23:30:00Z", "Asia/Tokyo"), /^Tomorrow at 8:30\sAM$/);
    assert.match(label("2030-06-15T13:00:00Z", "Asia/Tokyo"), /^Today at 10:00\sPM$/);

    assert.equal(untilLabel(now + 60_000, now), "in 1 minute");
    assert.equal(untilLabel(now + 45 * 60_000, now), "in 45 minutes");
    assert.equal(untilLabel(now + 3_600_000, now), "in 1 hour");
    assert.equal(untilLabel(now + 47 * 3_600_000, now), "in 47 hours");
    assert.equal(untilLabel(now + 5 * 86_400_000, now), "in 5 days");
    assert.equal(untilLabel(now - 60_000, now), "in 1 minute", "never reads as the past");

    assert.equal(startSummary(null), "Now");
    assert.equal(startSummary("2030-06-14T09:00"), "Later", "a time that won't validate doesn't get described");
    assert.match(startSummary("2030-06-16T09:00"), /^Tomorrow at 9:00/);
  });
});

test("scheduling: recurring schedules default to something ready to save, and preview the next run", () => {
  const repo = (id: string, isFactory = false) => ({ id, isFactory }) as Parameters<typeof newScheduleInput>[0][number];
  const repos = [repo("app"), repo("crane", true), repo("api")];

  const fresh = newScheduleInput(repos, [], "America/Toronto");
  assert.deepEqual(fresh, { repoId: "crane", daysMask: 62, localTime: "09:00", timezone: "America/Toronto", preApprove: false, enabled: true });
  assert.equal(newScheduleInput(repos, [{ repoId: "crane" }], "UTC").repoId, "app", "moves on to a repo this member doesn't cover");
  assert.equal(newScheduleInput(repos, repos.map((r) => ({ repoId: r.id })), "UTC").repoId, "crane", "all covered: back to Crane's own");
  assert.equal(newScheduleInput([], [], "UTC").repoId, "", "no repos: nothing to preselect");

  // Monday 2030-06-17, 08:00 in Toronto.
  const now = Date.parse("2030-06-17T12:00:00Z");
  const preview = schedulePreview(fresh, now, "en-US");
  assert.ok("next" in preview);
  assert.match(preview.next, /^Today at 9:00\sAM$/);
  const afterSlot = schedulePreview({ ...fresh, localTime: "07:00" }, now, "en-US");
  assert.ok("next" in afterSlot);
  assert.match(afterSlot.next, /^Tomorrow at 7:00\sAM$/);
  assert.deepEqual(schedulePreview({ ...fresh, daysMask: 0 }, now), { problem: "Choose at least one day." });
  assert.ok("problem" in schedulePreview({ ...fresh, timezone: "Not/AZone" }, now));
  assert.ok("problem" in schedulePreview({ ...fresh, localTime: "" }, now));

  assert.equal(daysLabel(62), "Weekdays");
  assert.equal(daysLabel(127), "Every day");
  assert.equal(daysLabel(65), "Weekends");
  assert.equal(daysLabel(1 | (1 << 1) | (1 << 3)), "Mon, Wed, Sun", "Monday first");
  assert.match(timeOfDayLabel("13:05", "en-US"), /^1:05\sPM$/);

  const slot = (id: string, nextFireAt: string, enabled = true) => ({ id, nextFireAt, enabled }) as Parameters<typeof nextSchedule>[0][number];
  assert.equal(nextSchedule([]), null);
  assert.equal(nextSchedule([slot("paused", "2030-01-01T00:00:00Z", false)]), null);
  assert.equal(nextSchedule([slot("later", "2030-02-01T00:00:00Z"), slot("paused", "2030-01-01T00:00:00Z", false), slot("soon", "2030-01-15T00:00:00Z")])!.id, "soon");
});
