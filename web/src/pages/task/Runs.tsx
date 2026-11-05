import { runCostLabel, runTokens, type AgentRun } from "@crane/contracts";
import { driverLabel, RUN_KIND_LABEL } from "../../lib/api";
import { ago, compact, plural, usd } from "../../lib/format";
import { runOutcomeLabel } from "./task-view";

function runMeta(run: AgentRun): string {
  const tokens = runTokens(run);
  return [
    runOutcomeLabel(run.outcome),
    run.driver === "unknown" ? null : driverLabel(run.driver),
    run.model,
    run.turns ? plural(run.turns, "turn") : null,
    tokens ? `${compact(tokens)} tokens` : null,
    ago(run.startedAt),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What each agent run cost: one per attempt, plus any conflict resolution while merging. */
export function Runs({ runs }: { runs: AgentRun[] }) {
  return (
    <details className="runs">
      <summary>{plural(runs.length, "agent run")}</summary>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <span className="runs-head">
              <span>{RUN_KIND_LABEL[r.kind]}</span>
              <span className="tabular">{r.outcome === "running" ? "Running" : runCostLabel(r, usd)}</span>
            </span>
            <span className="runs-meta">{runMeta(r)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
