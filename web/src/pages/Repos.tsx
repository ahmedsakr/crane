import { useState } from "react";
import { useApp } from "../lib/app-context";
import type { Repo } from "../lib/api";
import { ChecksSheet } from "./repos/ChecksSheet";
import { ConnectRepoForm } from "./repos/ConnectRepoForm";
import { RepoRow } from "./repos/RepoRow";

export function Repos() {
  const { overview, refresh } = useApp();
  const [checksRepo, setChecksRepo] = useState<Repo | null>(null);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Repos</h1>
      </div>
      <p className="muted" style={{ maxWidth: "60ch" }}>
        The codebases the factory works on. Agents never touch your checkout directly: changes happen on their own branch,
        in a separate worktree.
      </p>

      <ConnectRepoForm onConnected={refresh} />

      <ul className="rows card" style={{ padding: "0 18px", marginTop: 20 }}>
        {overview?.repos.map((r) => (
          <li key={r.id}>
            <RepoRow repo={r} onChecks={setChecksRepo} />
          </li>
        ))}
      </ul>
      {checksRepo && <ChecksSheet repo={checksRepo} onClose={() => setChecksRepo(null)} />}
    </>
  );
}
