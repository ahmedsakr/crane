import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../App";
import { api, driverLabel, type DriverInfo } from "../lib/api";
import { ago, plural } from "../lib/format";
import { useDrivers, useTick } from "../lib/hooks";
import { Empty, useToast } from "../components/bits";

/** The agents the crew can run on. The default is what new tasks use unless the operator picks another. */
function RunsOn({ drivers, onChange }: { drivers: DriverInfo[]; onChange: (d: DriverInfo[]) => void }) {
  const toast = useToast();
  const { refresh } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const choose = async (d: DriverInfo) => {
    setBusy(d.name);
    try {
      onChange(await api.setDefaultDriver(d.name));
      toast({ text: `New tasks run on ${d.label}` });
      refresh();
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Runs on</h2>
      </div>
      <p className="muted" style={{ maxWidth: "60ch", margin: "0 0 12px", fontSize: 14 }}>
        New tasks use the default agent. You can pick another for any task when you start it.
      </p>
      <ul className="rows card" style={{ padding: "0 18px" }}>
        {drivers.map((d) => (
          <li key={d.name}>
            <div className="row" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
              <span style={{ minWidth: 0 }}>
                <span className="row-title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ color: d.available ? undefined : "var(--graphite)" }}>{d.label}</span>
                  {d.isDefault && <span className="chip chip-crane">default</span>}
                </span>
                <span className="row-meta" style={{ display: "block", whiteSpace: "normal" }}>
                  {d.hint}
                </span>
              </span>
              <span>
                {d.isDefault ? null : d.available ? (
                  <button className="btn btn-quiet btn-sm" disabled={!!busy} onClick={() => choose(d)}>
                    Make default
                  </button>
                ) : (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Not installed
                  </span>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Crew() {
  const { overview: o } = useApp();
  const { drivers, set } = useDrivers();
  useTick();
  if (!o) return null;
  const driver = driverLabel(drivers?.find((d) => d.isDefault)?.name ?? o.factory.driver);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Crew</h1>
      </div>
      <p className="muted" style={{ maxWidth: "60ch" }}>
        {o.factory.running
          ? `${plural(o.agents.length, "agent")}, on ${driver} unless a task asks for another. Each picks up the oldest queued task when it's free.`
          : "The factory is off. Run crane serve to bring the crew in."}
        {o.factory.driver === "simulated" && " Simulated agents don't call a model; they're for trying Crane out."}
      </p>

      {o.agents.length === 0 ? (
        <div style={{ marginTop: 20 }}>
          <Empty title="No agents yet">
            Start the factory with <span className="mono">crane serve --agents 3</span>.
          </Empty>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))",
            gap: 16,
            marginTop: 20,
          }}
        >
          {o.agents.map((a) => {
            const doing = a.taskId ? o.inFlight.find((m) => m.id === a.taskId) : null;
            return (
              <div className="card card-pad" key={a.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className={`avatar ${a.state === "working" ? "working" : ""}`} style={{ width: 44, height: 44, fontSize: 18 }}>
                    {a.name[0]}
                  </span>
                  <span>
                    <span className="agent-name" style={{ display: "block", fontSize: 16 }}>
                      {a.name}
                    </span>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {a.state === "working"
                        ? `Working on ${driverLabel(a.driver)}`
                        : a.state === "paused"
                          ? "Paused"
                          : "Waiting for work"}
                    </span>
                  </span>
                  {a.state === "working" && <span className="dot dot-running" style={{ marginLeft: "auto" }} />}
                </div>
                <div style={{ marginTop: 16, fontSize: 14, minHeight: 42 }}>
                  {doing ? (
                    <Link to={`/tasks/${doing.id}`} style={{ fontWeight: 600 }}>
                      {doing.title}
                    </Link>
                  ) : (
                    <span className="muted">Nothing assigned</span>
                  )}
                </div>
                <dl className="facts" style={{ marginTop: 12, borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
                  <dt>Finished</dt>
                  <dd className="tabular">{a.tasksCompleted}</dd>
                  <dt>Last active</dt>
                  <dd>{ago(a.lastActiveAt) || "—"}</dd>
                </dl>
              </div>
            );
          })}
        </div>
      )}

      {drivers && drivers.length > 0 && <RunsOn drivers={drivers} onChange={set} />}
    </>
  );
}
