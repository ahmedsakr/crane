import { driverLabel, EFFORT_LEVELS, MODEL_SUGGESTIONS, type DriverInfo, type RunnerSummary } from "@crane/contracts";

export const CREW_ROUTE = "Factory crew";
export const CONTAINER_REQUIRED = "Choose a container. Admins require containers for operator tasks.";

export function runnerStatus(runner: RunnerSummary): string {
  const busy = `${runner.busy} of ${runner.capacity} busy`;
  if (runner.online) return `Online · ${busy}`;
  if (!runner.lastSeenAt) return `Offline · Never connected · ${busy}`;
  const seen = new Date(runner.lastSeenAt);
  const time = seen.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const when = seen.toDateString() === new Date().toDateString() ? time : `${seen.toLocaleDateString()} at ${time}`;
  return `Offline since ${when} · ${busy}`;
}

export function runnerDrivers(runner: RunnerSummary | undefined): DriverInfo[] {
  const names = runner?.drivers.length ? runner.drivers : ["claude-code", "codex"] as const;
  return names.map((name, i) => ({
    name,
    label: driverLabel(name),
    available: true,
    hint: "",
    isDefault: !!runner?.drivers.length && i === 0,
    efforts: EFFORT_LEVELS[name],
    models: MODEL_SUGGESTIONS[name],
    model: null,
    effort: null,
  }));
}
