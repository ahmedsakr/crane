import { api, ruleLabel, type Overview, type Repo } from "../../lib/api";
import { useAction } from "../../lib/action";
import { useApp } from "../../lib/app-context";
import { newTaskInstruction, openTasksNote } from "../../lib/repos";

type ConnectedRepo = Overview["repos"][number];

function AllowedTools({ repo }: { repo: ConnectedRepo }) {
  const { refresh } = useApp();
  const { run } = useAction(refresh);
  if (repo.tools.allowed.length === 0) return null;
  return (
    <span className="allowed-tools">
      <span className="row-meta">Also allowed</span>
      {repo.tools.allowed.map((rule) => (
        <span className="chip" key={rule}>
          <span className="mono">{ruleLabel(rule)}</span>
          <button
            className="chip-x"
            aria-label={`Stop allowing ${ruleLabel(rule)}`}
            title={`Stop allowing ${ruleLabel(rule)}`}
            onClick={() => run(rule, () => api.disallowTool(repo.id, rule), `Stopped allowing ${ruleLabel(rule)} for ${repo.name}`)}
          >
            ×
          </button>
        </span>
      ))}
    </span>
  );
}

function RepoActions({ repo, onChecks }: { repo: ConnectedRepo; onChecks: (repo: Repo) => void }) {
  const { refresh, instruct } = useApp();
  const { run } = useAction(refresh);
  return (
    <span style={{ display: "flex", gap: 6 }}>
      <button className="btn btn-quiet btn-sm" aria-label={`Checks for ${repo.name}`} onClick={() => onChecks(repo)}>
        Checks
      </button>
      <button className="btn btn-quiet btn-sm" onClick={() => instruct(newTaskInstruction(repo))}>
        New task
      </button>
      {!repo.isFactory && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => run("disconnect", () => api.removeRepo(repo.id), `Disconnected ${repo.name}`)}
        >
          Disconnect
        </button>
      )}
    </span>
  );
}

export function RepoRow({ repo, onChecks }: { repo: ConnectedRepo; onChecks: (repo: Repo) => void }) {
  return (
    <div className="row" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
      <span style={{ minWidth: 0 }}>
        <span className="row-title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {repo.name}
          {repo.isFactory && <span className="chip chip-crane">factory</span>}
        </span>
        <span className="row-meta mono" style={{ display: "block" }}>
          {repo.path} · {repo.defaultBranch}
          {openTasksNote(repo.openTasks)}
        </span>
        <AllowedTools repo={repo} />
      </span>
      <RepoActions repo={repo} onChecks={onChecks} />
    </div>
  );
}
