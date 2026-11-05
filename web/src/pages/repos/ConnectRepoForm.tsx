import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../lib/toast";
import { useSubmit } from "../../lib/use-submit";

export function ConnectRepoForm({ onConnected }: { onConnected: () => void }) {
  const toast = useToast();
  const [path, setPath] = useState("");
  const { busy, error, submit } = useSubmit();

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void submit(async () => {
      const repo = await api.addRepo(path.trim());
      setPath("");
      toast({ text: `Connected ${repo.name}` });
      onConnected();
    });
  };

  return (
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
  );
}
