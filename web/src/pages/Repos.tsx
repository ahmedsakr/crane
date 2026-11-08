import { useState } from "react";
import { useApp } from "../lib/app-context";
import { ChecksSheet } from "./repos/ChecksSheet";
import { CommandsSheet } from "./repos/CommandsSheet";
import { ConnectRepoForm } from "./repos/ConnectRepoForm";
import { RepoRow, type RepoSheet } from "./repos/RepoRow";

export function Repos() {
  const { overview, refresh } = useApp();
  const [sheet, setSheet] = useState<RepoSheet | null>(null);
  const close = () => setSheet(null);

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
            <RepoRow repo={r} onOpen={setSheet} />
          </li>
        ))}
      </ul>
      {sheet?.kind === "checks" && <ChecksSheet repo={sheet.repo} onClose={close} />}
      {sheet?.kind === "commands" && (
        <CommandsSheet repo={sheet.repo} current={sheet.repo.tools.commands} onSaved={refresh} onClose={close} />
      )}
    </>
  );
}
