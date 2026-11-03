import { crewScheduleLabel, errorMessage } from "@crane/contracts";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import * as ui from "../ui.js";
import { crewMember } from "./shared.js";

/** `crane agents schedule`: recurring maintenance runs. */
export function registerCrewSchedules(agents: Command, ctx: CliContext): void {
  const schedules = agents.command("schedule").description("Recurring maintenance runs (Sunday is day 0)");
  registerAddAndList(schedules, ctx);
  registerScheduleStates(schedules, ctx);
  registerUpdate(schedules, ctx);
}

function registerAddAndList(schedules: Command, { store, actions }: CliContext): void {
  schedules.command("add <member>")
    .requiredOption("--repo <repo>", "repo name or id")
    .requiredOption("--days <days>", "comma-separated weekdays: 0=Sun through 6=Sat")
    .requiredOption("--time <HH:MM>", "local start time")
    .requiredOption("--timezone <zone>", "IANA timezone, e.g. America/Toronto")
    .option("--pre-approve", "approve each run ahead of time and waive visual review including conflict resolutions")
    .action((member: string, opts: { repo: string; days: string; time: string; timezone: string; preApprove?: boolean }) => {
      try {
        const days = opts.days.split(",");
        if (days.some((d) => !/^[0-6]$/.test(d))) throw new Error("Use comma-separated days 0 through 6");
        const repo = store.getRepo(opts.repo);
        if (!repo) throw new Error(`No repo ${opts.repo}`);
        const s = actions.saveCrewSchedule(crewMember(store, member).id, {
          repoId: repo.id, daysMask: days.reduce((mask, d) => mask | (1 << Number(d)), 0),
          localTime: opts.time, timezone: opts.timezone, preApprove: !!opts.preApprove, enabled: true,
        });
        ui.ok(`Added ${s.id} · Next: ${s.nextFireAt}`);
      } catch (err) { ui.fail(errorMessage(err)); }
    });
  schedules.command("list <member>").option("--json", "machine-readable schedules")
    .action((member: string, opts: { json?: boolean }) => {
      try {
        const list = actions.listCrewSchedules(crewMember(store, member).id);
        if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
        for (const s of list) console.log(`${s.id} · ${store.getRepo(s.repoId)?.name} · ${crewScheduleLabel(s)} · ${s.enabled ? `Next: ${s.nextFireAt}` : "Paused"} · ${s.preApprove ? "Pre-approved" : "Waits for review"}${s.lastOutcome ? ` · ${s.lastOutcome}` : ""}`);
        if (!list.length) console.log("No schedules");
      } catch (err) { ui.fail(errorMessage(err)); }
    });
}

function registerScheduleStates(schedules: Command, { store, actions }: CliContext): void {
  for (const operation of ["remove", "pause", "resume"] as const) {
    schedules.command(`${operation} <member> <schedule>`).action((member: string, id: string) => {
      try {
        const a = crewMember(store, member);
        const s = actions.listCrewSchedules(a.id).find((s) => s.id === id);
        if (!s) throw new Error("No such crew schedule");
        if (operation === "remove") actions.removeCrewSchedule(a.id, id);
        else actions.saveCrewSchedule(a.id, { ...s, enabled: operation === "resume" }, id);
        ui.ok(`${operation === "remove" ? "Removed" : operation === "pause" ? "Paused" : "Resumed"} ${id}`);
      } catch (err) { ui.fail(errorMessage(err)); }
    });
  }
}

function registerUpdate(schedules: Command, { store, actions }: CliContext): void {
  schedules.command("update <member> <schedule>")
    .option("--repo <repo>", "repo name or id")
    .option("--days <days>", "comma-separated weekdays: 0=Sun through 6=Sat")
    .option("--time <HH:MM>", "local start time")
    .option("--timezone <zone>", "IANA timezone")
    .option("--pre-approve", "pre-approve each run and waive visual review including conflict resolutions")
    .option("--no-pre-approve", "wait for review after each run")
    .action((member: string, id: string, opts: { repo?: string; days?: string; time?: string; timezone?: string; preApprove?: boolean }) => {
      try {
        const a = crewMember(store, member);
        const s = actions.listCrewSchedules(a.id).find((s) => s.id === id);
        if (!s) throw new Error("No such crew schedule");
        const days = opts.days?.split(",");
        if (days?.some((d) => !/^[0-6]$/.test(d))) throw new Error("Use comma-separated days 0 through 6");
        const repo = opts.repo ? store.getRepo(opts.repo) : null;
        if (opts.repo && !repo) throw new Error(`No repo ${opts.repo}`);
        actions.saveCrewSchedule(a.id, { ...s, repoId: repo?.id ?? s.repoId,
          daysMask: days ? days.reduce((mask, d) => mask | (1 << Number(d)), 0) : s.daysMask,
          localTime: opts.time ?? s.localTime, timezone: opts.timezone ?? s.timezone, preApprove: opts.preApprove ?? s.preApprove }, id);
        ui.ok(`Updated ${id}`);
      } catch (err) { ui.fail(errorMessage(err)); }
    });
}
