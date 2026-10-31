import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApp } from "../App";
import { api, KIND_LABEL, type Analytics as Data } from "../lib/api";
import { compact, plural, usd } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { Dot, Empty } from "../components/bits";

const RANGES = [7, 30, 90] as const;
type Days = (typeof RANGES)[number];

const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  new Date(iso).toLocaleDateString([], opts);

/** The smallest round amount at or above `v`, so the axis tops out near the tallest day. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v - 1e-9) ?? 10) * p;
}

const tick = (n: number) => `$${+n.toFixed(2)}`;

/** Daily spend as columns. Each column's full-height slot is its hover and focus target. */
function DailyChart({ daily }: { daily: Data["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceCeil(Math.max(...daily.map((d) => d.usd)));
  const h = hover !== null ? daily[hover] : null;
  const ticks = [max, max / 2, 0];
  const labelEvery = Math.ceil(daily.length / 6);

  return (
    <div className="spend-chart" onPointerLeave={() => setHover(null)}>
      <div className="spend-axis" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="tabular">
            {tick(t)}
          </span>
        ))}
      </div>
      <div className="spend-plot">
        {ticks.map((t) => (
          <div key={t} className="spend-grid" style={{ bottom: `${(t / max) * 100}%` }} aria-hidden />
        ))}
        <div className="spend-cols" role="list" aria-label="Spend by day">
          {daily.map((d, i) => (
            <div
              key={d.day}
              role="listitem"
              className={`spend-col ${hover === i ? "on" : ""}`}
              tabIndex={0}
              aria-label={`${dayLabel(d.day, { weekday: "long", month: "long", day: "numeric" })}: ${usd(d.usd)}, ${plural(d.runs, "run")}`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              {d.usd > 0 && <span className="spend-bar" style={{ height: `max(2px, ${(d.usd / max) * 100}%)` }} />}
            </div>
          ))}
        </div>
        {h && (
          // Beside the column, level with its top, and never outside the plot.
          <div
            className="spend-tip"
            role="status"
            style={{
              bottom: `clamp(0px, calc(${(h.usd / max) * 100}% - 22px), calc(100% - 46px))`,
              ...(hover! < daily.length / 2
                ? { left: `calc(${((hover! + 1) / daily.length) * 100}% + 6px)` }
                : { right: `calc(${((daily.length - hover!) / daily.length) * 100}% + 6px)` }),
            }}
          >
            <strong className="tabular">{usd(h.usd)}</strong>
            <span>
              {dayLabel(h.day, { weekday: "short", month: "short", day: "numeric" })} · {plural(h.runs, "run")}
            </span>
          </div>
        )}
      </div>
      <div className="spend-x" aria-hidden>
        {daily.map((d, i) => (
          <span key={d.day}>{(daily.length - 1 - i) % labelEvery === 0 ? dayLabel(d.day) : ""}</span>
        ))}
      </div>
    </div>
  );
}

/** A ranked breakdown: name, a magnitude bar, the amount. Every value is printed, so the bars need no hover. */
function Breakdown({ title, rows }: { title: string; rows: { key: string; label: string; usd: number; tasks: number }[] }) {
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

export function Analytics() {
  const { overview } = useApp();
  const [params, setParams] = useSearchParams();
  const days = (RANGES.find((d) => String(d) === params.get("days")) ?? 30) as Days;
  const { data: a, error } = usePoll(() => api.analytics(days), 10000, [days]);
  const repoName = (id: string | null) => overview?.repos.find((r) => r.id === id)?.name;

  const span = `the last ${days} days`;
  const delta = a ? a.spendUsd - a.prevSpendUsd : 0;
  const tokensIn = a ? a.tokens.input + a.tokens.cacheRead + a.tokens.cacheWrite : 0;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Analytics</h1>
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((d) => (
            <button key={d} aria-pressed={days === d} onClick={() => setParams(d === 30 ? {} : { days: String(d) }, { replace: true })}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="muted">{error}</p>
      ) : !a ? (
        <p className="muted">Loading…</p>
      ) : a.runs === 0 ? (
        <div style={{ marginTop: 20 }}>
          <Empty title={`Nothing spent in ${span}`}>
            Each agent run's cost shows up here once it finishes{days < 90 ? ". Try a longer range." : "."}
          </Empty>
        </div>
      ) : (
        <>
          <section className="card card-pad spend-hero" aria-label="Spend">
            <div className="spend-headline">
              <div>
                <div className="spend-number">{usd(a.spendUsd)}</div>
                <div className="muted">
                  spent in {span}
                  {" · "}
                  {a.prevSpendUsd === 0
                    ? `nothing in the ${days} days before`
                    : `${delta >= 0 ? "+" : "−"}${usd(Math.abs(delta))} vs the ${days} days before`}
                </div>
              </div>
              <dl className="spend-stats">
                <div>
                  <dt>Per shipped task</dt>
                  <dd>{a.shipped.tasks ? usd(a.shipped.usd / a.shipped.tasks) : "—"}</dd>
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
            <DailyChart daily={a.daily} />
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
                  {[...a.daily].reverse().map((d) => (
                    <tr key={d.day}>
                      <td>{dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" })}</td>
                      <td className="tabular">{usd(d.usd)}</td>
                      <td className="tabular">{d.runs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          <div className="spend-split">
            <Breakdown
              title="By repo"
              rows={a.byRepo.map((r) => ({ key: r.repoId ?? "none", label: r.name, usd: r.usd, tasks: r.tasks }))}
            />
            <Breakdown title="By type" rows={a.byKind.map((k) => ({ key: k.kind, label: KIND_LABEL[k.kind], usd: k.usd, tasks: k.tasks }))} />
          </div>

          {a.topTasks.length > 0 && (
            <section className="section" aria-labelledby="top-tasks">
              <div className="section-head">
                <h2 className="section-title" id="top-tasks">
                  Most expensive tasks
                </h2>
              </div>
              <ul className="rows card" style={{ padding: "0 16px" }}>
                {a.topTasks.map((m) => (
                  <li key={m.id}>
                    <Link className="row spend-row" to={`/tasks/${m.id}`}>
                      <Dot status={m.status} />
                      <span style={{ minWidth: 0 }}>
                        <span className="row-title" style={{ display: "block" }}>
                          {m.title}
                        </span>
                        <span className="row-meta" style={{ display: "block" }}>
                          {[repoName(m.repoId), KIND_LABEL[m.kind], m.runs > 1 ? plural(m.runs, "run") : null].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <span className="spend-row-usd tabular">{usd(m.usd)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="muted spend-note">
            {compact(tokensIn)} tokens in ({compact(a.tokens.cacheRead)} read from cache) and {compact(a.tokens.output)} out.
            Costs are what each agent reports for each run, at API prices. On a subscription they're an estimate, not a bill.
            Codex reports tokens only, so its runs count as $0.
          </p>
        </>
      )}
    </>
  );
}
