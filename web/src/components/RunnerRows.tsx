import type { RunnerSummary } from "@crane/contracts";
import { runnerStatus } from "../lib/runners";
import { Chevron } from "./Chevron";

export function RunnerRows({ runners, defaultId, onChoose }: {
  runners: RunnerSummary[];
  defaultId?: string | null;
  onChoose: (runner: RunnerSummary) => void;
}) {
  if (!runners.length) return <p className="muted">No containers yet.</p>;
  return <ul className="account-devices account-links" aria-label="Containers">
    {runners.map((runner) => <li key={runner.id}>
      <button type="button" className="sheet-link" onClick={() => onChoose(runner)}>
        <span className="account-link-text">
          <span>{runner.name}{defaultId === runner.id && " · Default"}</span>
          <small className="muted">{runnerStatus(runner)}</small>
        </span>
        <Chevron />
      </button>
    </li>)}
  </ul>;
}
