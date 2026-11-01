import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ACTIVE_STATUSES,
  api,
  AUTONOMY_LABEL,
  KIND_LABEL,
  RUN_KIND_LABEL,
  STATUS_LABEL,
  acceptanceFor,
  choosableDrivers,
  driverLabel,
  settingsLabel,
  lastMergeOutcome,
  lookoutsLabel,
  unmetAcceptance,
  type AgentRun,
  diffFiles,
  type FollowUpOptions,
  type TaskDetail,
  type TaskDiff,
  type TaskEvent,
} from "../lib/api";
import { useDrivers, useEventStream, usePoll, useTick } from "../lib/hooks";
import { ago, clock, compact, duration, plural, usd } from "../lib/format";
import { BlockedItem, StatusChip, useToast } from "../components/bits";
import { useApp } from "../lib/app-context";
import { FollowUpForm } from "../components/FollowUpForm";

/** Group consecutive tool calls so the timeline reads as a story, with the mechanics one click away. */
function groupEvents(events: TaskEvent[]) {
  const out: (TaskEvent | { tools: TaskEvent[] })[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === "tool") {
      if (last && "tools" in last) last.tools.push(e);
      else out.push({ tools: [e] });
    } else out.push(e);
  }
  return out;
}

function Timeline({ events }: { events: TaskEvent[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const groups = groupEvents(events);
  return (
    <ol className="timeline">
      {groups.map((g, i) =>
        "tools" in g ? (
          open.has(i) || g.tools.length === 1 ? (
            g.tools.map((e) => (
              <li key={e.id} className="tl tl-tool">
                <span className="tl-time">{clock(e.ts)}</span>
                {e.message}
              </li>
            ))
          ) : (
            <li key={`g${i}`}>
              <button className="tool-fold" onClick={() => setOpen(new Set(open).add(i))}>
                {plural(g.tools.length, "step")}: {g.tools[0]!.message}
                {g.tools.length > 1 ? ", …" : ""} <span aria-hidden>▸</span>
              </button>
            </li>
          )
        ) : (
          <li key={g.id} className={`tl tl-${g.type}`}>
            <span className="tl-time">{clock(g.ts)}</span>
            <span className="tl-msg">{g.message}</span>
          </li>
        ),
      )}
    </ol>
  );
}

/** What each agent run cost: one per attempt, plus any conflict resolution while merging. */
function Runs({ runs }: { runs: AgentRun[] }) {
  return (
    <details className="runs">
      <summary>{plural(runs.length, "agent run")}</summary>
      <ul>
        {runs.map((r) => {
          const tokens = r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens;
          return (
            <li key={r.id}>
              <span className="runs-head">
                <span>{RUN_KIND_LABEL[r.kind]}</span>
                <span className="tabular">{r.outcome === "running" ? "Running" : r.costStatus === "unknown"
                  ? r.costUsd ? `${usd(r.costUsd)} + unknown` : "Unknown"
                  : `${r.costStatus === "estimated" ? "~" : ""}${usd(r.costUsd)}`}</span>
              </span>
              <span className="runs-meta">
                {[
                  r.outcome === "failed" ? "Failed" : r.outcome === "cancelled" ? "Cancelled" : null,
                  r.driver === "unknown" ? null : driverLabel(r.driver),
                  r.model,
                  r.turns ? plural(r.turns, "turn") : null,
                  tokens ? `${compact(tokens)} tokens` : null,
                  ago(r.startedAt),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * A task's changes, fetched while `on`. A running task's keep changing, so with `live`
 * they refresh every few seconds while the tab is visible.
 */
function useTaskDiff(id: string, on: boolean, live: boolean) {
  const [state, setState] = useState<{ id: string; diff: TaskDiff | null; error: string | null }>({ id, diff: null, error: null });
  useEffect(() => {
    if (!on) return;
    let current = true;
    const load = () =>
      api.diff(id).then(
        (diff) => current && setState({ id, diff, error: null }),
        (e: Error) => current && setState((s) => ({ id, diff: s.id === id ? s.diff : null, error: e.message })),
      );
    load();
    const t = live ? setInterval(() => document.visibilityState === "visible" && load(), 4000) : undefined;
    return () => {
      current = false;
      clearInterval(t);
    };
  }, [id, on, live]);
  // Never show another task's changes while this one's load.
  return state.id === id ? state : { diff: null, error: null };
}

function Diff({ id }: { id: string }) {
  const { diff, error } = useTaskDiff(id, true, false);
  return <DiffView diff={diff} error={error} />;
}

function DiffView({ diff: d, error }: { diff: TaskDiff | null; error: string | null }) {
  if (!d) return <p className="muted">{error ? `Couldn't load changes: ${error}` : "Loading changes…"}</p>;
  const diff = d.diff;
  if (!diff) return <p className="muted">{d.live ? "No changes yet." : "No changes on the branch."}</p>;
  return (
    <div className="diff" role="region" aria-label="Changes" tabIndex={0}>
      {diff.split("\n").map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith("diff ")
              ? "file"
              : l.startsWith("@@")
                ? "hunk"
                : l.startsWith("+") && !l.startsWith("+++")
                  ? "add"
                  : l.startsWith("-") && !l.startsWith("---")
                    ? "del"
                    : ""
          }
        >
          {l || " "}
        </div>
      ))}
    </div>
  );
}

export function TaskPage() {
  const { id = "" } = useParams();
  const { refresh: refreshApp } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, refresh } = usePoll<TaskDetail>(() => api.task(id), 3000, [id]);
  const [live, setLive] = useState<TaskEvent[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [finding, setFinding] = useState<number | null>(null);
  const { drivers } = useDrivers();
  useTick(5000);

  const lastId = data?.events.at(-1)?.id ?? 0;
  useEffect(() => setLive([]), [lastId]);
  useEffect(() => setFinding(null), [id]);
  useEventStream(data && ACTIVE_STATUSES.includes(data.task.status) ? id : null, (e) =>
    setLive((l) => (l.some((x) => x.id === e.id) ? l : [...l, e])),
    lastId,
  );

  const events = useMemo(() => {
    const seen = new Set<number>();
    return [...(data?.events ?? []), ...live].filter((e) => !seen.has(e.id) && seen.add(e.id));
  }, [data, live]);

  // While an agent works on its branch, follow its changes as they happen, uncommitted work included.
  const working = data?.task.status === "running" && !!data.task.branch;
  const sofar = useTaskDiff(id, working, true);
  const sofarFiles = useMemo(() => (sofar.diff ? diffFiles(sofar.diff.diff) : []), [sofar.diff]);

  if (error) return <p className="muted" style={{ paddingTop: 40 }}>{error}</p>;
  if (!data) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;
  const { task: m, repo, agent } = data;
  const report = m.report;
  const main = repo?.defaultBranch ?? "main";
  const merge = lastMergeOutcome(events);
  // The agent that worked it, or the one it asked for. Before it starts with no choice, nothing to say.
  const ranOn = data.runs.filter((r) => r.kind === "work" && r.driver !== "unknown").at(-1)?.driver ?? null;
  const usedDriver = ranOn ?? m.driver;
  const runsOn = usedDriver ? driverLabel(usedDriver) : null;
  const otherAgents = choosableDrivers(drivers ?? []).filter((d) => d.name !== usedDriver);
  // Only before review: once it's there, Approve is the decision.
  const canPreApprove = ["queued", "running"].includes(m.status) && m.autonomy !== "observe" && !!repo;
  // Prerequisites still holding a queued task back. Waiving them is the operator approving a reduced scope.
  // A backend older than this page sends no gates; read them as empty until it restarts.
  const prerequisites = data.prerequisites ?? [];
  const acceptance = m.acceptance ?? [];
  const waitingOn = m.status === "queued" && !m.prerequisitesWaivedAt ? prerequisites.filter((p) => !p.met) : [];
  const unmet = report ? unmetAcceptance({ acceptance, report }) : [];
  const acceptanceGate = acceptance.length ? " and its report shows every acceptance criterion met" : "";

  const run = async (label: string, fn: () => Promise<unknown>, done: string, after?: (r: unknown) => void) => {
    setBusy(label);
    try {
      const r = await fn();
      toast({ text: done });
      refresh();
      refreshApp();
      after?.(r);
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const followUp = (i: number, opts: FollowUpOptions) =>
    run("f" + i, () => api.followUp(m.id, i, opts), "Follow-up queued", (r) => nav(`/tasks/${(r as { id: string }).id}`));

  return (
    <article>
      <Link className="back" to="/tasks">
        ← Tasks
      </Link>
      <div className="detail">
        <div style={{ minWidth: 0 }}>
          <div className="meta-line">
            <StatusChip status={m.status} />
            <span className="chip">{KIND_LABEL[m.kind]}</span>
            {repo && <span className="chip">{repo.name}</span>}
            {canPreApprove && m.preApprovedAt && <span className="chip chip-ok">Pre-approved</span>}
          </div>
          <h1 className="detail-title">{m.title}</h1>

          {m.status === "needs_review" && (
            <div className="decision">
              <div className="decision-copy">
                <strong>
                  {merge?.error ? `Couldn't merge into ${main}` : m.branch ? "Changes are ready for review" : "The report is ready"}
                </strong>
                <span>
                  {unmet.length > 0 &&
                    `The report doesn't show ${unmet.length === 1 ? "an acceptance criterion" : `${unmet.length} acceptance criteria`} met, so approving accepts a reduced scope. `}
                  {merge?.error
                    ? `${merge.error.replace(/\.$/, "")}. Try again, approve only to merge it yourself, or decline.`
                    : m.branch
                      ? `Approving merges ${m.branch} into ${main} and pushes it. An agent resolves any conflicts. Declining throws it away.`
                      : "Act on a finding below, or mark this as reviewed."}
                </span>
              </div>
              <div className="decision-actions">
                <button className="btn btn-quiet" disabled={!!busy} onClick={() => run("reject", () => api.reject(m.id), "Declined")}>
                  Decline
                </button>
                {m.branch && (
                  <button
                    className="btn btn-quiet"
                    disabled={!!busy}
                    onClick={() => run("approve-only", () => api.approve(m.id, { merge: false }), "Approved. The branch is kept for you.")}
                  >
                    Approve only
                  </button>
                )}
                <button
                  className="btn btn-crane"
                  disabled={!!busy}
                  onClick={() => run("approve", () => api.approve(m.id), m.branch ? "Approved. Merging it now." : "Marked as reviewed")}
                >
                  {m.branch ? "Approve and merge" : "Mark as reviewed"}
                </button>
              </div>
            </div>
          )}

          {report ? (
            <p className="summary">{report.summary}</p>
          ) : m.status === "running" ? (
            <p className="summary muted">{agent?.name ?? "An agent"} is working on this. Updates appear below as they happen.</p>
          ) : m.status === "queued" ? (
            <p className="summary muted">
              {waitingOn.length
                ? `Waiting for ${waitingOn.map((p) => p.id).join(", ")} to land.`
                : m.assignee && agent
                  ? agent.active ? `Waiting for ${agent.name}, who picks it up when free.` : `Waiting for ${agent.name}, who is on-call. Activate them on the Crew page.`
                  : "Waiting for a free agent."}
            </p>
          ) : null}
          {waitingOn.length > 0 && (
            <div className="card card-pad pre-approval">
              <div className="pre-approval-copy">
                <strong>Waiting for prerequisites</strong>
                <span>
                  {waitingOn.length === 1
                    ? `It starts once this lands on ${main}. Waive it to start now without its changes, approving a reduced scope.`
                    : `It starts once these land on ${main}. Waive them to start now without their changes, approving a reduced scope.`}
                </span>
                <ul className="gate-list">
                  {waitingOn.map((p) => (
                    <li key={p.id}>
                      <Link className="mono" to={`/tasks/${p.id}`}>{p.id}</Link>
                      <span>{p.title}</span>
                      <StatusChip status={p.status} />
                    </li>
                  ))}
                </ul>
              </div>
              <button className="btn btn-quiet btn-sm" disabled={!!busy}
                onClick={() => run("waive", () => api.waivePrerequisites(m.id), "Waived prerequisites. It starts with the next free agent.")}>
                Waive prerequisites
              </button>
            </div>
          )}
          {canPreApprove && (
            <div className="card card-pad pre-approval">
              <div className="pre-approval-copy">
                <strong>{m.preApprovedAt ? "Pre-approved" : "Merge when it passes"}</strong>
                <span>
                  {m.preApprovedAt
                    ? `Once its checks pass${acceptanceGate}, Crane merges it into ${main} without waiting for your review. Otherwise nothing merges.`
                    : `Pre-approve it and Crane merges it into ${main} once its checks pass${acceptanceGate}, without waiting for your review.`}
                </span>
              </div>
              {m.preApprovedAt ? (
                <button className="btn btn-quiet btn-sm" disabled={!!busy}
                  onClick={() => run("pre-approve", () => api.undoPreApproval(m.id), "Undid pre-approval. It waits for your review.")}>
                  Undo pre-approval
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" disabled={!!busy}
                  onClick={() => run("pre-approve", () => api.preApprove(m.id), `Pre-approved. It merges into ${main} once its checks pass.`)}>
                  Pre-approve
                </button>
              )}
            </div>
          )}
          {acceptance.length > 0 && (
            <section className="section" aria-labelledby="acceptance">
              <div className="section-head">
                <h2 className="section-title" id="acceptance">
                  Acceptance criteria{" "}
                  <span className="count">{report ? `${acceptance.length - unmet.length} of ${acceptance.length} met` : acceptance.length}</span>
                </h2>
              </div>
              <div className="card card-pad" style={{ paddingBlock: 0 }}>
                {acceptance.map((c, i) => {
                  const said = report ? acceptanceFor(report, c) : undefined;
                  return (
                    <div className="acceptance-item" key={i}>
                      {!report ? <span className="chip">{i + 1}</span>
                        : said?.met ? <span className="chip chip-ok">Met</span>
                          : <span className="chip chip-bad">{said ? "Not met" : "Not reported"}</span>}
                      <p>{c}</p>
                      {said?.evidence && <p className="evidence">{said.evidence}</p>}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {!!report?.screenshots?.length && (
            <section className="section" aria-labelledby="screenshots">
              <div className="section-head">
                <h2 className="section-title" id="screenshots">Screenshots <span className="count">{report.screenshots.length}</span></h2>
              </div>
              <div className="task-screenshots">
                {report.screenshots.map(image => {
                  const url = `/api/tasks/${encodeURIComponent(m.id)}/screenshots/${encodeURIComponent(image.path)}`;
                  return (
                    <figure className="card" key={image.path}>
                      <a href={url} target="_blank" rel="noreferrer" aria-label={`Open screenshot: ${image.caption}`}>
                        <img src={url} alt={image.caption} loading="lazy" />
                      </a>
                      <figcaption>{image.caption}</figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          )}
          {report?.validation?.map((run, i) => (
            <details key={i} className="card card-pad">
              <summary>{run.phase} check: {run.status} · {run.command ?? "Configuration"}</summary>
              <p className="mono">{run.commit} · exit {run.exitCode ?? "—"} · {run.durationMs} ms</p>
              <pre style={{ whiteSpace: "pre-wrap" }}>{run.logs}</pre>
            </details>
          ))}
          {m.status === "merging" && (
            <p className="muted">
              {agent ? `${agent.name} is merging this into ${main}.` : `Waiting for a free agent to merge this into ${main}.`} Progress
              appears in the activity below.
            </p>
          )}

          {data.blocked.length > 0 && (
            <section className="section" aria-labelledby="blocked">
              <div className="section-head">
                <h2 className="section-title" id="blocked">
                  Blocked <span className="count">{data.blocked.length}</span>
                </h2>
              </div>
              <div className="card">
                {data.blocked.map((b) => (
                  <BlockedItem
                    key={b.rule}
                    b={b}
                    taskId={m.id}
                    onDone={() => {
                      refresh();
                      refreshApp();
                    }}
                  />
                ))}
              </div>
              <p className="muted section-note">Allowing applies to every agent in {repo?.name ?? "this repo"} from its next run.</p>
            </section>
          )}

          {report && report.findings.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">
                  Findings <span className="count">{report.findings.length}</span>
                </h2>
              </div>
              <div className="card">
                {report.findings.map((f, i) => (
                  <div className="finding" key={i}>
                    <div style={{ minWidth: 0 }}>
                      <h4>{f.title}</h4>
                      <p>{f.detail}</p>
                      <div className="chips">
                        <span className={`chip ${f.impact === "high" ? "chip-crane" : ""}`}>{f.impact} impact</span>
                        <span className="chip">{f.effort} effort</span>
                      </div>
                    </div>
                    <div>
                      <button className="btn btn-quiet btn-sm" disabled={!!busy} aria-expanded={finding === i} onClick={() => setFinding(finding === i ? null : i)}>
                        Make this change
                      </button>
                    </div>
                    {finding === i && (
                      drivers?.length ? <FollowUpForm key={`${m.id}-${i}`} task={m} drivers={drivers} busy={!!busy}
                        onSubmit={opts => followUp(i, opts)} onClose={() => setFinding(null)} />
                        : <p className="follow-up-form muted">{drivers ? "Couldn't load agents. Reload to try again." : "Loading agents…"}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {working && sofar.diff && (
            <section className="section" aria-labelledby="changes-so-far">
              <div className="section-head">
                <h2 className="section-title" id="changes-so-far">
                  Changes so far {sofarFiles.length > 0 && <span className="count">{sofarFiles.length}</span>}
                </h2>
                {sofarFiles.length > 0 && (
                  <button className="btn btn-ghost btn-sm" aria-expanded={showDiff} onClick={() => setShowDiff((s) => !s)}>
                    {showDiff ? "Hide changes" : "Show changes"}
                  </button>
                )}
              </div>
              {sofarFiles.length > 0 ? (
                <div className="card card-pad" style={{ paddingBlock: 6 }}>
                  <ul className="files">
                    {sofarFiles.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="muted section-note">No changes yet.</p>
              )}
              {showDiff && sofarFiles.length > 0 && <DiffView diff={sofar.diff} error={sofar.error} />}
              {sofar.diff.live && sofarFiles.length > 0 && (
                <p className="muted section-note">Includes work it hasn't committed yet, and updates as it goes.</p>
              )}
            </section>
          )}

          {!working && report && report.changedFiles.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">
                  Changed files <span className="count">{report.changedFiles.length}</span>
                </h2>
                {m.branch && (
                  <button className="btn btn-ghost btn-sm" aria-expanded={showDiff} onClick={() => setShowDiff((s) => !s)}>
                    {showDiff ? "Hide changes" : "Show changes"}
                  </button>
                )}
              </div>
              <div className="card card-pad" style={{ paddingBlock: 6 }}>
                <ul className="files">
                  {report.changedFiles.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
              {showDiff && <Diff id={m.id} />}
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">
                Activity
                {(m.status === "running" || m.status === "merging") && <span className="dot dot-running" title="Live" />}
              </h2>
            </div>
            <Timeline events={events} />
          </section>
        </div>

        <aside className="rail">
          <div className="card card-pad">
            <dl className="facts">
              <dt>Task</dt>
              <dd className="mono">{m.id}</dd>
              <dt>Freedom</dt>
              <dd>{AUTONOMY_LABEL[m.autonomy]}</dd>
              <dt>Agent</dt>
              <dd>{[agent?.name, runsOn].filter(Boolean).join(" on ") || "—"}</dd>
              {settingsLabel(m) && <>
                <dt>Model settings</dt>
                <dd>{settingsLabel(m)}</dd>
              </>}
              {lookoutsLabel(m.lookouts) && <>
                <dt>Also looks for</dt>
                <dd>{lookoutsLabel(m.lookouts)}</dd>
              </>}
              <dt>Started</dt>
              <dd>{m.startedAt ? ago(m.startedAt) : "Not yet"}</dd>
              <dt>Took</dt>
              <dd className="tabular">{duration(m.startedAt, m.finishedAt)}</dd>
              {m.costUsd > 0 && (
                <>
                  <dt>Cost</dt>
                  <dd className="tabular">{usd(m.costUsd)}</dd>
                </>
              )}
              {m.branch && (
                <>
                  <dt>Branch</dt>
                  <dd className="mono">{m.branch}</dd>
                </>
              )}
              {prerequisites.length > 0 && (
                <>
                  <dt>Prerequisites</dt>
                  <dd>
                    {prerequisites.map((p, i) => (
                      <span key={p.id}>
                        {i > 0 && ", "}
                        <Link className="mono" to={`/tasks/${p.id}`} title={`${p.title} · ${p.met ? "landed" : STATUS_LABEL[p.status]}`}>{p.id}</Link>
                      </span>
                    ))}
                    {m.prerequisitesWaivedAt && <span className="muted"> · waived</span>}
                  </dd>
                </>
              )}
            </dl>
            {data.runs.length > 1 || (data.runs[0] && (data.runs[0].costUsd > 0 || data.runs[0].outputTokens > 0)) ? (
              <Runs runs={data.runs} />
            ) : null}
          </div>

          <div className="card card-pad">
            <h3 className="card-title">Instruction</h3>
            <p style={{ margin: 0, fontSize: 14, whiteSpace: "pre-wrap", color: "var(--ink-2)" }}>{m.brief}</p>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["queued", "running"].includes(m.status) && (
              <button className="btn btn-quiet btn-sm" disabled={!!busy} onClick={() => run("cancel", () => api.cancel(m.id), "Cancelled")}>
                Cancel task
              </button>
            )}
            {["failed", "cancelled", "rejected", "done", "approved", "merged"].includes(m.status) && (
              <button
                className="btn btn-quiet btn-sm"
                disabled={!!busy}
                onClick={() => run("retry", () => api.retry(m.id), "Queued again", (r) => nav(`/tasks/${(r as { id: string }).id}`))}
              >
                Run again
              </button>
            )}
            {/* When it didn't work out, offer the other installed agents too. */}
            {["failed", "cancelled", "rejected"].includes(m.status) &&
              otherAgents.map((d) => (
                <button
                  key={d.name}
                  className="btn btn-quiet btn-sm"
                  disabled={!!busy}
                  onClick={() =>
                    run("retry", () => api.retry(m.id, d.name), `Queued again on ${d.label}`, (r) =>
                      nav(`/tasks/${(r as { id: string }).id}`),
                    )
                  }
                >
                  Run again on {d.label}
                </button>
              ))}
          </div>
          {(m.status === "approved" || m.status === "done") && m.branch && repo && (
            <div className="card card-pad">
              <h3 className="card-title">Merge into {main}</h3>
              <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--ink-2)" }}>
                Crane merges {m.branch} and pushes it. An agent resolves any conflicts.
              </p>
              <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => run("merge", () => api.merge(m.id), "Merging it now")}>
                Merge
              </button>
              <details style={{ marginTop: 12 }}>
                <summary className="muted" style={{ fontSize: 13, cursor: "pointer" }}>
                  Or merge it yourself
                </summary>
                <p className="mono" style={{ margin: "8px 0 0", overflowWrap: "anywhere" }}>
                  git -C {repo.path} merge {m.branch}
                </p>
              </details>
            </div>
          )}
          {m.status === "merged" && merge && (
            <div className="card card-pad">
              <h3 className="card-title">Merged into {main}</h3>
              <p style={{ margin: 0, fontSize: 14, color: "var(--ink-2)" }}>
                {merge.commit ? <span className="mono">{merge.commit.slice(0, 8)}</span> : "Already there"}
                {merge.pushedTo ? `, pushed to ${merge.pushedTo}.` : "."}
              </p>
              {merge.checkoutBehind && (
                <>
                  <p style={{ margin: "12px 0 6px", fontSize: 14, color: "var(--ink-2)" }}>
                    Your checkout had local changes, so Crane left it alone. Catch it up when it's clean:
                  </p>
                  <p className="mono" style={{ margin: 0, overflowWrap: "anywhere" }}>
                    git -C {merge.checkoutBehind} pull --ff-only
                  </p>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </article>
  );
}
