import { Link, useNavigate } from "react-router-dom";
import { useApp } from "../App";
import { api, type Task } from "../lib/api";
import { ago, plural } from "../lib/format";
import { useTick } from "../lib/hooks";
import { Slab } from "../components/Slab";
import { Empty, TaskRow, useToast } from "../components/bits";

function ReviewItem({ m, repoName, onDone }: { m: Task; repoName?: string; onDone: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const findings = m.report?.findings.length ?? 0;
  const files = m.report?.changedFiles.length ?? 0;
  const isChange = !!m.branch;
  const quickApprove = async () => {
    await api.approve(m.id);
    toast({ text: isChange ? "Approved. The branch is ready to merge." : "Marked as reviewed" });
    onDone();
  };
  return (
    <div className="review-row">
      <div style={{ minWidth: 0 }}>
        <Link to={`/tasks/${m.id}`} className="row-title" style={{ display: "block" }}>
          {m.title}
        </Link>
        <div className="row-meta">
          {[repoName, isChange ? plural(files, "file") + " changed" : plural(findings, "finding"), ago(m.finishedAt)]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {m.report?.summary && <div className="review-summary">{m.report.summary}</div>}
      </div>
      <div className="actions">
        <button className="btn btn-quiet btn-sm" onClick={() => nav(`/tasks/${m.id}`)}>
          Review
        </button>
        <button className="btn btn-primary btn-sm" onClick={quickApprove}>
          {isChange ? "Approve" : "Done"}
        </button>
      </div>
    </div>
  );
}

export function Home() {
  const { overview: o, refresh, instruct } = useApp();
  useTick();
  if (!o) return <div style={{ padding: 40 }} className="muted">Connecting to the factory…</div>;

  const repoName = (id: string | null) => o.repos.find((r) => r.id === id)?.name;
  const hasTargets = o.repos.some((r) => !r.isFactory);
  const nothing = !o.needsReview.length && !o.inFlight.length && !o.recent.length;

  return (
    <div className="home">
      <div>
        <Slab o={o} />

        {!o.factory.running && (
          <div className="notice">
            <strong>The factory is off.</strong>
            <span>
              Run <span className="mono">crane serve</span> in a terminal to start the agents. Tasks you add now will wait in
              the queue.
            </span>
          </div>
        )}

        {o.needsReview.length > 0 && (
          <section className="section" aria-labelledby="needs-you">
            <div className="section-head">
              <h2 className="section-title" id="needs-you">
                Needs you <span className="count">{o.needsReview.length}</span>
              </h2>
            </div>
            {o.needsReview.map((m) => (
              <ReviewItem key={m.id} m={m} repoName={repoName(m.repoId)} onDone={refresh} />
            ))}
          </section>
        )}

        <section className="section" aria-labelledby="in-flight">
          <div className="section-head">
            <h2 className="section-title" id="in-flight">
              In flight <span className="count">{o.inFlight.length || ""}</span>
            </h2>
            <Link className="link-quiet" to="/tasks">
              All tasks
            </Link>
          </div>
          {o.inFlight.length ? (
            <ul className="rows card" style={{ padding: "0 16px" }}>
              {o.inFlight.map((m) => (
                <TaskRow key={m.id} m={m} repoName={repoName(m.repoId)} />
              ))}
            </ul>
          ) : nothing ? (
            <Empty
              title={hasTargets ? "Give the factory its first task" : "Connect a repo to get started"}
              action={
                hasTargets ? (
                  <button className="btn btn-primary" onClick={() => instruct()}>
                    Instruct the factory
                  </button>
                ) : (
                  <Link className="btn btn-primary" to="/repos">
                    Connect a repo
                  </Link>
                )
              }
            >
              {hasTargets
                ? "Describe the work in plain words. Agents investigate first and ask before they change anything."
                : "Point Crane at a git repository. You can also start with Crane itself: it's already connected."}
            </Empty>
          ) : (
            <p className="muted" style={{ margin: "4px 0" }}>
              Nothing running right now.{" "}
              <button className="inline-link" onClick={() => instruct()}>
                Start a task
              </button>
            </p>
          )}
        </section>

        {o.recent.length > 0 && (
          <section className="section" aria-labelledby="recent">
            <div className="section-head">
              <h2 className="section-title" id="recent">
                Recently finished
              </h2>
            </div>
            <ul className="rows card" style={{ padding: "0 16px" }}>
              {o.recent.map((m) => (
                <TaskRow key={m.id} m={m} repoName={repoName(m.repoId)} />
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="rail" aria-label="Crew and repos">
        <div className="card card-pad">
          <h3 className="card-title">
            Crew
            <Link className="link-quiet" to="/crew">
              Details
            </Link>
          </h3>
          {o.agents.length === 0 && <p className="muted" style={{ margin: 0, fontSize: 14 }}>Agents clock in when the factory starts.</p>}
          {o.agents.map((a) => {
            const doing = a.taskId ? o.inFlight.find((m) => m.id === a.taskId) : null;
            return (
              <div className="agent" key={a.id}>
                <span className={`avatar ${a.state === "working" ? "working" : ""}`}>{a.name[0]}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="agent-name" style={{ display: "block" }}>
                    {a.name}
                  </span>
                  <span className="agent-doing" style={{ display: "block" }}>
                    {doing ? (
                      <Link to={`/tasks/${doing.id}`}>{doing.title}</Link>
                    ) : a.state === "paused" ? (
                      "Paused"
                    ) : (
                      "Waiting for work"
                    )}
                  </span>
                </span>
                {a.state === "working" && <span className="dot dot-running" />}
              </div>
            );
          })}
        </div>

        <div className="card card-pad">
          <h3 className="card-title">
            Repos
            <Link className="link-quiet" to="/repos">
              Manage
            </Link>
          </h3>
          {o.repos.map((r) => (
            <div className="repo-item" key={r.id}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                {r.isFactory && <span className="chip chip-crane">factory</span>}
              </span>
              <span className="muted" style={{ fontSize: 13 }}>
                {r.openTasks ? `${r.openTasks} open` : ""}
              </span>
            </div>
          ))}
          <button
            className="btn btn-quiet btn-sm"
            style={{ marginTop: 10, width: "100%" }}
            onClick={() => instruct("Research what Crane should build next to need me less")}
          >
            Ask Crane to improve itself
          </button>
        </div>
      </aside>
    </div>
  );
}
