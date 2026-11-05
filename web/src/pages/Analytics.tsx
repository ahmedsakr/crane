import { useSearchParams } from "react-router-dom";
import type { Analytics as Report } from "@crane/contracts";
import { api } from "../lib/api";
import { RANGES, emptyRangeHint, parseRange, rangeParams, tokensIn, unknownCostNote, type Days } from "../lib/analytics";
import { compact } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { Empty } from "../components/Empty";
import { Breakdowns } from "./analytics/Breakdowns";
import { SpendHero } from "./analytics/SpendHero";
import { TopTasks } from "./analytics/TopTasks";

function SpendNote({ report: a }: { report: Report }) {
  return (
    <p className="muted spend-note">
      {compact(tokensIn(a.tokens))} tokens in ({compact(a.tokens.cacheRead)} read from cache) and {compact(a.tokens.output)} out.
      Costs use agent reports or model-specific estimates at standard API token prices. On a subscription they're an estimate, not a bill.
      Codex estimates exclude tools and pricing surcharges; unrecognized or unspecified models have unknown costs.
      {unknownCostNote(a.unknownCostRuns)}
    </p>
  );
}

function AnalyticsBody({ report: a, error, days }: { report: Report | null; error: string | null; days: Days }) {
  if (error) return <p className="muted">{error}</p>;
  if (!a) return <p className="muted">Loading…</p>;
  if (a.runs === 0) {
    return (
      <div style={{ marginTop: 20 }}>
        <Empty title={`Nothing spent in the last ${days} days`}>
          Each agent run's cost shows up here once it finishes{emptyRangeHint(days)}
        </Empty>
      </div>
    );
  }
  return (
    <>
      <SpendHero report={a} days={days} />
      <Breakdowns report={a} />
      <TopTasks tasks={a.topTasks} />
      <SpendNote report={a} />
    </>
  );
}

export function Analytics() {
  const [params, setParams] = useSearchParams();
  const days = parseRange(params.get("days"));
  const { data, error } = usePoll(() => api.analytics(days), 10000, [days]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Analytics</h1>
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((d) => (
            <button key={d} aria-pressed={days === d} onClick={() => setParams(rangeParams(d), { replace: true })}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      <AnalyticsBody report={data} error={error} days={days} />
    </>
  );
}
