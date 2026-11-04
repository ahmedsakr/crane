import { Link } from "react-router-dom";
import type { Overview } from "../lib/api";
import { agentsOnShift } from "../lib/overview";

type Agent = Overview["agents"][number];

function AgentDoing({ agent, inFlight }: { agent: Agent; inFlight: Overview["inFlight"] }) {
  const doing = agent.taskId ? inFlight.find((task) => task.id === agent.taskId) : null;
  if (doing) return <Link to={`/tasks/${doing.id}`}>{doing.title}</Link>;
  return <>{agent.state === "paused" ? "Paused" : "Waiting for work"}</>;
}

function CrewCard({ o }: { o: Overview }) {
  return (
    <div className="card card-pad">
      <h3 className="card-title">
        Crew
        <Link className="link-quiet" to="/crew">
          Details
        </Link>
      </h3>
      {o.agents.length === 0 && <p className="muted" style={{ margin: 0, fontSize: 14 }}>Agents clock in when the factory starts.</p>}
      {agentsOnShift(o.agents).map((agent) => (
        <div className="agent" key={agent.id}>
          <span className={`avatar ${agent.state === "working" ? "working" : ""}`}>{agent.name[0]}</span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="agent-name" style={{ display: "block" }}>
              {agent.name}
            </span>
            <span className="agent-doing" style={{ display: "block" }}>
              <AgentDoing agent={agent} inFlight={o.inFlight} />
            </span>
          </span>
          {agent.state === "working" && <span className="dot dot-running" />}
        </div>
      ))}
    </div>
  );
}

function ReposCard({ repos, instruct }: { repos: Overview["repos"]; instruct: (text?: string) => void }) {
  return (
    <div className="card card-pad">
      <h3 className="card-title">
        Repos
        <Link className="link-quiet" to="/repos">
          Manage
        </Link>
      </h3>
      {repos.map((repo) => (
        <div className="repo-item" key={repo.id}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontWeight: 600 }}>{repo.name}</span>
            {repo.isFactory && <span className="chip chip-crane">factory</span>}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            {repo.openTasks ? `${repo.openTasks} open` : ""}
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
  );
}

export function HomeRail({ o, instruct }: { o: Overview; instruct: (text?: string) => void }) {
  return (
    <aside className="rail" aria-label="Crew and repos">
      <CrewCard o={o} />
      <ReposCard repos={o.repos} instruct={instruct} />
    </aside>
  );
}
