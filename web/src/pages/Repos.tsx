import { useEffect, useId, useState } from "react";
import { useApp } from "../lib/app-context";
import { api, ruleLabel, type Repo } from "../lib/api";
import { useToast } from "../components/bits";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../components/Sheet";

/** Edit the commands a repo's work must pass. Save stays off until the saved list has loaded, so a failed load can't wipe it. */
function ChecksSheet({ repo, onClose }: { repo: Pick<Repo, "id" | "name">; onClose: () => void }) {
  const toast = useToast();
  const formId = useId();
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commands = (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

  useEffect(() => {
    let stale = false;
    api.repoChecks(repo.id).then(
      (saved) => { if (!stale) setText(saved.join("\n")); },
      (e: Error) => { if (!stale) setError(e.message); },
    );
    return () => { stale = true; };
  }, [repo.id]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.configureChecks(repo.id, commands);
      toast({ text: `Saved checks for ${repo.name}` });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const note = error
    ? <span className="error-text" role="alert">{error}</span>
    : text !== null && !commands.length ? "With no checks, work in this repo can't pass review or merge." : undefined;
  return (
    <Sheet onClose={onClose}>
      <SheetHead title={`Checks for ${repo.name}`} subtitle="What work must pass before review and merge. Crane runs these itself, in the task's worktree." />
      <SheetBody>
        <form id={formId} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="tuning-field">
            <span>Shell commands, one per line</span>
            <textarea className="input mono" rows={5} value={text ?? ""} disabled={text === null || saving}
              placeholder={text === null ? "" : "npm test"} spellCheck={false} autoComplete="off"
              onChange={(e) => setText(e.target.value)} />
          </label>
        </form>
      </SheetBody>
      <SheetFoot note={note}>
        <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" type="submit" form={formId} disabled={text === null || saving}>Save</button>
      </SheetFoot>
    </Sheet>
  );
}

export function Repos() {
  const { overview, refresh, instruct } = useApp();
  const toast = useToast();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checksRepo, setChecksRepo] = useState<Repo | null>(null);

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
                {r.tools.allowed.length > 0 && (
                  <span className="allowed-tools">
                    <span className="row-meta">Also allowed</span>
                    {r.tools.allowed.map((rule) => (
                      <span className="chip" key={rule}>
                        <span className="mono">{ruleLabel(rule)}</span>
                        <button
                          className="chip-x"
                          aria-label={`Stop allowing ${ruleLabel(rule)}`}
                          title={`Stop allowing ${ruleLabel(rule)}`}
                          onClick={async () => {
                            try {
                              await api.disallowTool(r.id, rule);
                              toast({ text: `Stopped allowing ${ruleLabel(rule)} for ${r.name}` });
                              refresh();
                            } catch (e) {
                              toast({ text: (e as Error).message });
                            }
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-quiet btn-sm" aria-label={`Checks for ${r.name}`} onClick={() => setChecksRepo(r)}>
                  Checks
                </button>
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
      {checksRepo && <ChecksSheet repo={checksRepo} onClose={() => setChecksRepo(null)} />}
    </>
  );
}
