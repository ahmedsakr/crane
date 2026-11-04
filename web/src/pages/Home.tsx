import { errorMessage } from "@crane/contracts";
import { Link, useNavigate } from "react-router-dom";
import { useApp } from "../lib/app-context";
import { api, type Overview, type TaskSummary } from "../lib/api";
import { ago, plural } from "../lib/format";
import { useTick } from "../lib/hooks";
import { goalReviewLabel, hasTargetRepo, isSiteEmpty, needsYouCount, repoNamer } from "../lib/overview";
import { HomeRail } from "../components/HomeRail";
import { Site } from "../components/Site";
import { Slab } from "../components/Slab";
import { useToast } from "../lib/toast";
import { BlockedItem } from "../components/BlockedItem";
import { Empty } from "../components/Empty";
import { Section } from "../components/Section";
import { TaskRow } from "../components/TaskRow";

type RepoName = (id: string | null) => string | undefined;
type Instruct = (text?: string) => void;

function ReviewItem({ task, repoName, onDone }: { task: TaskSummary; repoName?: string; onDone: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const isChange = !!task.branch;
  const outcome = isChange ? plural(task.changedFileCount, "file") + " changed" : plural(task.findingCount, "finding");
  const quickApprove = async () => {
    try {
      await api.approve(task.id);
      toast({ text: isChange ? "Approved. Merging it now." : "Marked as reviewed" });
    } catch (e) {
      toast({ text: errorMessage(e) });
    }
    onDone();
  };
  return (
    <div className="review-row">
      <div style={{ minWidth: 0 }}>
        <Link to={`/tasks/${task.id}`} className="row-title" style={{ display: "block" }}>
          {task.title}
        </Link>
        <div className="row-meta">
          {[repoName, outcome, ago(task.finishedAt)].filter(Boolean).join(" · ")}
        </div>
        {task.reportSummary && <div className="review-summary">{task.reportSummary}</div>}
      </div>
      <div className="actions">
        <button className="btn btn-quiet btn-sm" onClick={() => nav(`/tasks/${task.id}`)}>
          Review
        </button>
        <button className="btn btn-primary btn-sm" onClick={quickApprove}>
          {isChange ? "Approve and merge" : "Done"}
        </button>
      </div>
    </div>
  );
}

function FactoryOffNotice() {
  return (
    <div className="notice">
      <strong>The factory is off.</strong>
      <span>
        Run <span className="mono">crane serve</span> in a terminal to start the agents. Tasks you add now will wait in
        the queue.
      </span>
    </div>
  );
}

function NeedsYou({ o, repoName, refresh }: { o: Overview; repoName: RepoName; refresh: () => void }) {
  const count = needsYouCount(o);
  if (!count) return null;
  return (
    <Section id="needs-you" title={<>Needs you <span className="count">{count}</span></>}>
      {o.goalsNeedingReview?.map((goal) => (
        <div className="review-row" key={goal.id}>
          <div style={{ minWidth: 0 }}><Link className="row-title" to={`/goals/${goal.id}`}>{goal.title}</Link><div className="row-meta">Goal · {goalReviewLabel(goal)} · {repoName(goal.repoId)}</div></div>
          <Link className="btn btn-primary btn-sm" to={`/goals/${goal.id}`}>Review goal</Link>
        </div>
      ))}
      {o.needsReview.map((task) => (
        <ReviewItem key={task.id} task={task} repoName={repoName(task.repoId)} onDone={refresh} />
      ))}
    </Section>
  );
}

function BlockedCommands({ blocked, refresh }: { blocked: Overview["blocked"]; refresh: () => void }) {
  if (!blocked.length) return null;
  return (
    <Section id="blocked" title={<>Blocked commands <span className="count">{blocked.length}</span></>}>
      <div className="card">
        {blocked.map((b) => (
          <BlockedItem key={`${b.repoId}:${b.rule}`} b={b} showTask onDone={refresh} />
        ))}
      </div>
    </Section>
  );
}

function TaskRows({ tasks, repoName }: { tasks: TaskSummary[]; repoName: RepoName }) {
  return (
    <ul className="rows card" style={{ padding: "0 16px" }}>
      {tasks.map((task) => (
        <TaskRow key={task.id} m={task} repoName={repoName(task.repoId)} />
      ))}
    </ul>
  );
}

function FirstStep({ hasTargets, instruct }: { hasTargets: boolean; instruct: Instruct }) {
  if (hasTargets) {
    return (
      <Empty
        title="Give the factory its first task"
        action={
          <button className="btn btn-primary" onClick={() => instruct()}>
            Instruct the factory
          </button>
        }
      >
        Describe the work in plain words. Agents investigate first and ask before they change anything.
      </Empty>
    );
  }
  return (
    <Empty
      title="Connect a repo to get started"
      action={
        <Link className="btn btn-primary" to="/repos">
          Connect a repo
        </Link>
      }
    >
      Point Crane at a git repository. You can also start with Crane itself: it's already connected.
    </Empty>
  );
}

function InFlight({ o, repoName, instruct }: { o: Overview; repoName: RepoName; instruct: Instruct }) {
  if (o.inFlight.length) return <TaskRows tasks={o.inFlight} repoName={repoName} />;
  if (isSiteEmpty(o)) return <FirstStep hasTargets={hasTargetRepo(o)} instruct={instruct} />;
  return (
    <p className="muted" style={{ margin: "4px 0" }}>
      Nothing running right now.{" "}
      <button className="inline-link" onClick={() => instruct()}>
        Start a task
      </button>
    </p>
  );
}

export function Home() {
  const { overview: o, refresh, instruct } = useApp();
  useTick();
  if (!o) return <div style={{ padding: 40 }} className="muted">Connecting to the factory…</div>;

  const repoName = repoNamer(o.repos);

  return (
    <div className="home">
      <div>
        <Slab o={o} />
        {!o.factory.running && <FactoryOffNotice />}
        <NeedsYou o={o} repoName={repoName} refresh={refresh} />
        <BlockedCommands blocked={o.blocked} refresh={refresh} />

        {!isSiteEmpty(o) && (
          <Section id="on-site" title="On site">
            <Site o={o} />
          </Section>
        )}

        <Section id="in-flight" title={<>In flight <span className="count">{o.inFlight.length || ""}</span></>}
          aside={<Link className="link-quiet" to="/tasks">All tasks</Link>}>
          <InFlight o={o} repoName={repoName} instruct={instruct} />
        </Section>

        {o.recent.length > 0 && (
          <Section id="recent" title="Recently finished">
            <TaskRows tasks={o.recent} repoName={repoName} />
          </Section>
        )}
      </div>

      <HomeRail o={o} instruct={instruct} />
    </div>
  );
}
