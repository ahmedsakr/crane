import { useState } from "react";
import { useApp } from "../App";
import { api } from "../lib/api";
import { useToast } from "../components/bits";

export function Repos() {
  const { overview, refresh, instruct } = useApp();
  const toast = useToast();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.addRepo(path.trim());
      setPath("");
      toast({ text: `Connected ${r.name}` });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Repos</h1>
      </div>
      <p className="muted" style={{ maxWidth: "60ch" }}>
        The codebases the factory works on. Agents never touch your checkout directly: changes happen on their own branch,
        in a separate worktree.
      </p>

      <form className="card card-pad" style={{ marginTop: 20 }} onSubmit={connect}>
        <label htmlFor="repo-path" className="card-title" style={{ display: "block" }}>
          Connect a repo
        </label>
        <div className="field">
          <input
            id="repo-path"
            className="input mono"
            placeholder="/home/you/code/my-app"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn btn-primary" disabled={!path.trim() || busy} style={{ height: 44 }}>
            Connect
          </button>
        </div>
        {error && (
          <p className="error-text" style={{ margin: "8px 0 0" }}>
            {error}
          </p>
        )}
        <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>
          Any local git repository. From a terminal: <span className="mono">crane repos add &lt;path&gt;</span>
        </p>
      </form>

      <ul className="rows card" style={{ padding: "0 18px", marginTop: 20 }}>
        {overview?.repos.map((r) => (
          <li key={r.id}>
            <div className="row" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
              <span style={{ minWidth: 0 }}>
                <span className="row-title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {r.name}
                  {r.isFactory && <span className="chip chip-crane">factory</span>}
                </span>
                <span className="row-meta mono" style={{ display: "block" }}>
                  {r.path} · {r.defaultBranch}
                  {r.openTasks ? ` · ${r.openTasks} open` : ""}
                </span>
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                <button
                  className="btn btn-quiet btn-sm"
                  onClick={() =>
                    instruct(
                      r.isFactory
                        ? "Research what Crane should build next to need me less"
                        : `Investigate open maintenance work in ${r.name}`,
                    )
                  }
                >
                  New task
                </button>
                {!r.isFactory && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      await api.removeRepo(r.id);
                      toast({ text: `Disconnected ${r.name}` });
                      refresh();
                    }}
                  >
                    Disconnect
                  </button>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
