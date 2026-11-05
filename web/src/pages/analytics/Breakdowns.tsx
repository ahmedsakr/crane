import { driverLabel, KIND_LABEL, type Analytics } from "@crane/contracts";
import { plural, usd } from "../../lib/format";

interface BreakdownRow {
  key: string;
  label: string;
  usd: number;
  tasks: number;
}

/** A ranked breakdown: name, a magnitude bar, the amount. Every value is printed, so the bars need no hover. */
function Breakdown({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  const max = Math.max(...rows.map((r) => r.usd), 0.0001);
  return (
    <div className="card card-pad">
      <h3 className="card-title">{title}</h3>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Nothing yet.
        </p>
      ) : (
        <ul className="spend-breakdown">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="spend-name">{r.label}</span>
              <span className="spend-amount tabular">{usd(r.usd)}</span>
              <span className="spend-track" aria-hidden>
                <span style={{ width: `${(r.usd / max) * 100}%` }} />
              </span>
              <span className="spend-sub">{plural(r.tasks, "task")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Breakdowns({ report: a }: { report: Analytics }) {
  return (
    <div className="spend-split">
      <Breakdown
        title="By agent"
        rows={a.byAgent.map((r) => ({ key: r.driver, label: driverLabel(r.driver), usd: r.usd, tasks: r.tasks }))}
      />
      <Breakdown
        title="By repo"
        rows={a.byRepo.map((r) => ({ key: r.repoId ?? "none", label: r.name, usd: r.usd, tasks: r.tasks }))}
      />
      <Breakdown title="By type" rows={a.byKind.map((k) => ({ key: k.kind, label: KIND_LABEL[k.kind], usd: k.usd, tasks: k.tasks }))} />
    </div>
  );
}
