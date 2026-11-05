import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { useDrivers } from "../../lib/hooks";
import { useSubmit } from "../../lib/use-submit";
import { AgentFields, NO_AGENT_CHOICE, agentRunOptions } from "../../components/AgentFields";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";

export function NewGoalSheet({ onClose }: { onClose: () => void }) {
  const { overview } = useApp();
  const { drivers } = useDrivers();
  const navigate = useNavigate();
  const form = useId();
  const [outcome, setOutcome] = useState("");
  const [repoId, setRepo] = useState(overview?.repos.length === 1 ? overview.repos[0]!.id : "");
  const [agent, setAgent] = useState(NO_AGENT_CHOICE);
  const { busy, error, submit } = useSubmit();
  const create = () => submit(async () => {
    const goal = await api.createGoal({ outcome, repoId, ...agentRunOptions(agent, drivers ?? []) });
    onClose();
    navigate(`/goals/${goal.id}`);
  });
  return (
    <Sheet onClose={onClose}>
      <SheetHead title="New goal" subtitle="Describe the outcome. A research agent will propose the work, order and agent assignments for your review." />
      <SheetBody>
        <form id={form} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="tuning-field">
            Desired outcome
            <textarea className="input" rows={6} required maxLength={20000} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="What should be possible when this goal is complete?" />
          </label>
          <label className="tuning-field">
            Repository
            <select className="input" required value={repoId} onChange={(e) => setRepo(e.target.value)}>
              <option value="">Choose a repo</option>
              {overview?.repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <details>
            <summary>Research agent</summary>
            <div className="sheet-fields goal-options">
              <AgentFields value={agent} onChange={setAgent} drivers={drivers ?? []} />
            </div>
          </details>
          <p className="muted">Research is read-only. Implementation waits until you approve a plan.</p>
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span role="alert" className="error-text">{error}</span> : undefined}>
        <button className="btn btn-primary" form={form} disabled={busy || !outcome.trim() || !repoId}>
          {busy ? "Starting…" : "Research goal"}
        </button>
      </SheetFoot>
    </Sheet>
  );
}
