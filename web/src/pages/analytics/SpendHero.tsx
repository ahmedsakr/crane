import type { Analytics } from "@crane/contracts";
import { DAY_SHORT, dayLabel, perShippedTask, spendComparison } from "../../lib/analytics";
import { plural, usd } from "../../lib/format";
import { DailyChart } from "./DailyChart";

function SpendHeadline({ report: a, days }: { report: Analytics; days: number }) {
  return (
    <div className="spend-headline">
      <div>
        <div className="spend-number">{usd(a.spendUsd)}</div>
        <div className="muted">
          spent in the last {days} days
          {" · "}
          {spendComparison(a, days)}
        </div>
      </div>
      <dl className="spend-stats">
        <div>
          <dt>Per shipped task</dt>
          <dd>{perShippedTask(a.shipped)}</dd>
        </div>
        <div>
          <dt>On work that didn't ship</dt>
          <dd>{usd(a.unshipped.usd)}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>
            {a.runs} <span className="muted">· {plural(a.tasks, "task")}</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** The chart's numbers for anyone who'd rather read them, newest first. */
function DailyTable({ daily }: { daily: Analytics["daily"] }) {
  return (
    <details className="spend-details">
      <summary>Show as a table</summary>
      <table className="spend-table">
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Spent</th>
            <th scope="col">Runs</th>
          </tr>
        </thead>
        <tbody>
          {[...daily].reverse().map((d) => (
            <tr key={d.day}>
              <td>{dayLabel(d.day, DAY_SHORT)}</td>
              <td className="tabular">{usd(d.usd)}</td>
              <td className="tabular">{d.runs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function SpendHero({ report: a, days }: { report: Analytics; days: number }) {
  return (
    <section className="card card-pad spend-hero" aria-label="Spend">
      <SpendHeadline report={a} days={days} />
      <DailyChart daily={a.daily} />
      <DailyTable daily={a.daily} />
    </section>
  );
}
