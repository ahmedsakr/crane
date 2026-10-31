import { Link } from "react-router-dom";
import { useApp } from "../App";
import { ago, plural } from "../lib/format";
import { useTick } from "../lib/hooks";
import { Empty } from "../components/bits";

export function Crew() {
  const { overview: o } = useApp();
  useTick();
  if (!o) return null;
  const driver = o.factory.driver === "claude-code" ? "Claude Code" : o.factory.driver === "simulated" ? "Simulated" : o.factory.driver;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Crew</h1>
      </div>
      <p className="muted" style={{ maxWidth: "60ch" }}>
        {o.factory.running
          ? `${plural(o.agents.length, "agent")} on ${driver}. Each picks up the oldest queued task when it's free.`
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
                      {a.state === "working" ? "Working" : a.state === "paused" ? "Paused" : "Waiting for work"}
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
    </>
  );
}
